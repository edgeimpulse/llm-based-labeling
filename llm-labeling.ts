import fs from 'fs';
import Path from 'path';
import program from 'commander';
import { EdgeImpulseApi } from 'edge-impulse-api';
import * as models from 'edge-impulse-api/build/library/';
import OpenAI from "openai";
import asyncPool from 'tiny-async-pool';

const packageVersion = (<{ version: string }>JSON.parse(fs.readFileSync(
    Path.join(__dirname, '..', 'package.json'), 'utf-8'))).version;

// This is passed in automatically for every job you run from a Data Source in Edge Impulse
if (!process.env.EI_PROJECT_API_KEY) {
    console.log('Missing EI_PROJECT_API_KEY');
    process.exit(1);
}

// Specified in parameters.json as a secret
if (!process.env.OPENAI_API_KEY) {
    console.log('Missing OPENAI_API_KEY');
    process.exit(1);
}

let API_URL = process.env.EI_API_ENDPOINT || 'https://studio.edgeimpulse.com/v1';
const API_KEY = process.env.EI_PROJECT_API_KEY;

API_URL = API_URL.replace('/v1', '');

program
    .description('Label using an LLM ' + packageVersion)
    .version(packageVersion)
    .requiredOption('--prompt <prompt>',
        `A prompt asking a question to the LLM. ` +
        `The answer should be a single label. ` +
        `E.g. "Is there a human in this picture, respond with only 'yes' or 'no'."`)
    .option('--disable-labels <labels>',
        `If a certain label is output, disable the data item. ` +
        `E.g. your prompt can be: "If the picture is blurry, respond with 'blurry'", ` +
        `and add "blurry" to the disabled labels. Multiple labels can be split by ",".`
    )
    .option('--image-quality <quality>', 'Quality of the image to send to GPT. Either "auto", "low" or "high" (default "auto")')
    .option('--limit <n>', `Max number of samples to process`)
    .option('--concurrency <n>', `Concurrency (default: 1)`)
    .option('--auto-convert-videos <value>', `Automatically split videos into individual frames (either 1 or 0 or "true" or "false")`)
    .option('--extract-frames-per-second <n>', `If video conversion is enabled, how many frames per second to extract (default: 10)`)
    .option('--data-ids-file <file>', 'File with IDs (as JSON)')
    .option('--propose-actions <job-id>', 'If this flag is passed in, only propose suggested actions')
    .option('--verbose', 'Enable debug logs')
    .allowUnknownOption(true)
    .parse(process.argv);

const api = new EdgeImpulseApi({ endpoint: API_URL });

// the replacement looks weird; but if calling this from CLI like
// "--prompt 'test\nanother line'" we'll get this still escaped
// (you could use $'test\nanotherline' but we won't do that in the Edge Impulse backend)
const promptArgv = (<string>program.prompt).replaceAll('\\n', '\n');
const disableLabelsArgv = (<string[]>(<string | undefined>program.disableLabels || '').split(',')).map(x => x.trim().toLowerCase()).filter(x => !!x);
const imageQualityArgv = (<'auto' | 'low' | 'high'>program.imageQuality) || 'auto';
const limitArgv = program.limit ? Number(program.limit) : undefined;
const concurrencyArgv = program.concurrency ? Number(program.concurrency) : 1;
const autoConvertVideos = program.autoConvertVideos === '1' || program.autoConvertVideos === 'true';
const framesPerSecond = autoConvertVideos ?
    (program.extractFramesPerSecond ? Number(program.extractFramesPerSecond) : 10) : 10;
const dataIdsFile = <string | undefined>program.dataIdsFile;
const proposeActionsJobId = program.proposeActions ?
    Number(program.proposeActions) :
    undefined;

if (isNaN(framesPerSecond)) {
    console.log('--extract-frames-per-second should be numeric if --auto-convert-videos was passed in');
    process.exit(1);
}
if (proposeActionsJobId && isNaN(proposeActionsJobId)) {
    console.log('--propose-actions should be numeric');
    process.exit(1);
}
let dataIds: number[] | undefined;
if (dataIdsFile) {
    if (!fs.existsSync(dataIdsFile)) {
        console.log(`"${dataIdsFile}" does not exist (via --data-ids-file)`);
        process.exit(1);
    }
    try {
        dataIds = <number[]>JSON.parse(fs.readFileSync(dataIdsFile, 'utf-8'));
        if (!Array.isArray(dataIds)) {
            throw new Error('Content of the file is not an array');
        }
        for (let ix = 0; ix < dataIds.length; ix++) {
            if (isNaN(dataIds[ix])) {
                throw new Error('The value at index ' + ix + ' is not numeric');
            }
        }
    }
    catch (ex2) {
        console.log(`Failed to parse "${dataIdsFile}" (via --data-ids-file), should be a JSON array with numbers`, ex2);
        process.exit(1);
    }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        await api.authenticate({
            method: 'apiKey',
            apiKey: API_KEY,
        });

        // listProjects returns a single project if authenticated by API key
        const project = (await api.projects.listProjects()).projects[0];

        console.log(`Labeling unlabeled data for "${project.owner} / ${project.name}"`);
        console.log(`    Prompt: "${promptArgv}"`);
        console.log(`    Disable samples with labels: ${disableLabelsArgv.length === 0 ? '-' : disableLabelsArgv.join(', ')}`);
        console.log(`    Image quality: ${imageQualityArgv}`);
        console.log(`    Limit no. of samples to label to: ${typeof limitArgv === 'number' ? limitArgv.toLocaleString() : 'No limit'}`);
        console.log(`    Concurrency: ${concurrencyArgv}`);
        console.log(`    Auto-convert videos: ${autoConvertVideos ? 'Yes' : 'No'}`);
        if (autoConvertVideos) {
            console.log(`    Video conversion fps: ${framesPerSecond})`);
        }
        if (dataIds) {
            if (dataIds.length < 6) {
                console.log(`    IDs: ${dataIds.join(', ')}`);
            }
            else {
                console.log(`    IDs: ${dataIds.slice(0, 5).join(', ')} and ${dataIds.length - 5} others`);
            }
        }
        console.log(``);

        if (autoConvertVideos) {
            console.log(`Finding uncoverted videos...`);
            const unconvertedVideos = await listAllVideos(project.id);
            console.log(`Finding unconverted OK (found ${unconvertedVideos.length} samples)`);
            console.log(``);

            console.log(`Converting ${unconvertedVideos.length} videos...`);
            let converted = 0;
            let convertIv = setInterval(() => {
                let currFile = (converted).toString().padStart(unconvertedVideos.length.toString().length, ' ');
                console.log(`[${currFile}/${unconvertedVideos.length}] Still converting videos...`);
            }, 3000);

            try {
                for (let s of unconvertedVideos) {
                    await api.rawData.splitSampleInFrames(project.id, s.id, {
                        fps: framesPerSecond
                    });
                    converted++;
                }
            }
            finally {
                clearInterval(convertIv);
            }

            console.log(`[${unconvertedVideos.length}/${unconvertedVideos.length}] Still converting videos...`);
            console.log(`Converting ${unconvertedVideos.length} videos OK`);
        }

        let samplesToProcess: models.Sample[];

        if (dataIds) {
            console.log(`Finding data by ID...`);
            samplesToProcess = await listDataByIds(project.id, dataIds);
            console.log(`Finding data by ID OK (found ${samplesToProcess.length} samples)`);
            console.log(``);
        }
        else {
            console.log(`Finding unlabeled data...`);
            samplesToProcess = await listAllUnlabeledData(project.id);
            console.log(`Finding unlabeled data OK (found ${samplesToProcess.length} samples)`);
            console.log(``);
        }

        samplesToProcess = samplesToProcess.sort((a, b) => a.id - b.id);

        const total = typeof limitArgv === 'number' ?
            (samplesToProcess.length > limitArgv ? limitArgv : samplesToProcess.length) :
            samplesToProcess.length;
        let processed = 0;
        let error = 0;
        let promptTokensTotal = 0;
        let completionTokensTotal = 0;
        let labelCount: { [k: string]: number } = { };

        const getSummary = () => {
            let labelStr = Object.keys(labelCount).map(k => k + '=' + labelCount[k]).join(', ');
            if (labelStr.length > 0) {
                return `(${labelStr}, error=${error})`;
            }
            else {
                return `(error=${error})`;
            }
        };

        let updateIv = setInterval(async () => {
            let currFile = (processed).toString().padStart(total.toString().length, ' ');
            console.log(`[${currFile}/${total}] Labeling samples... ` +
                getSummary());
        }, 3000);

        const model: OpenAI.Chat.ChatModel = 'gpt-4o-2024-08-06';

        const labelSampleWithOpenAI = async (sample: models.Sample) => {
            try {
                const json = await retryWithTimeout(async () => {
                    const imgBuffer = await api.rawData.getSampleAsImage(project.id, sample.id, { });

                    const resp = await openai.chat.completions.create({
                        model: model,
                        messages: [{
                        role: 'system',
                        content: `You always respond with the following JSON structure, regardless of the prompt: \`{ "label": "XXX", "reason": "YYY" }\`. ` +
                                `Put the requested answer in 'label', and put your reasoning in 'reason'.`,
                        }, {
                            role: 'user',
                            content: [{
                                type: 'text',
                                text: promptArgv,
                            }, {
                                type: 'image_url',
                                image_url: {
                                    url: 'data:image/jpeg;base64,' + (imgBuffer.toString('base64')),
                                    detail: imageQualityArgv,
                                }
                            }]
                        }]
                    });

                    // console.log('resp', JSON.stringify(resp, null, 4));
                    if (resp.usage) {
                        promptTokensTotal += resp.usage.prompt_tokens;
                        completionTokensTotal += resp.usage.completion_tokens;
                    }

                    if (resp.choices.length !== 1) {
                        throw new Error('Expected choices to have 1 item (' + JSON.stringify(resp) + ')');
                    }
                    if (resp.choices[0].message.role !== 'assistant') {
                        throw new Error('Expected choices[0].message.role to equal "assistant" (' + JSON.stringify(resp) + ')');
                    }
                    if (typeof resp.choices[0].message.content !== 'string') {
                        throw new Error('Expected choices[0].message.content to be a string (' + JSON.stringify(resp) + ')');
                    }

                    let respBody = resp.choices[0].message.content;

                    // many times we get a Markdown-like response... strip this
                    if (respBody.startsWith('```json') && respBody.endsWith('```')) {
                        respBody = respBody.slice('```json'.length, respBody.length - 3);
                    }

                    let jsonContent: { label: string, reason: string };
                    try {
                        jsonContent = <{ label: string, reason: string }>JSON.parse(respBody);
                        if (typeof jsonContent.label === 'number') {
                            // e.g. when you prompt it to return a digit
                            jsonContent.label = (<number>jsonContent.label).toString();
                        }
                        if (typeof jsonContent.label !== 'string') {
                            throw new Error('label was not of type string');
                        }
                        if (typeof jsonContent.reason !== 'string') {
                            throw new Error('reason was not of type string');
                        }
                    }
                    catch (ex2) {
                        let ex = <Error>ex2;
                        throw new Error('Failed to parse message content: ' + (ex.message + ex.toString()) +
                            ' (raw string: "' + resp.choices[0].message.content + '")');
                    }

                    return jsonContent;
                }, {
                    fnName: 'completions.create',
                    maxRetries: 3,
                    onWarning: (retriesLeft, ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] WARN: Failed to label ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}. Retries left=${retriesLeft}`);
                    },
                    onError: (ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] ERR: Failed to label ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}.`);
                    },
                    timeoutMs: 60000,
                });

                await retryWithTimeout(async () => {
                    // update metadata
                    sample.metadata = sample.metadata || {};
                    sample.metadata.reason = json.reason;
                    sample.metadata.prompt = promptArgv;

                    // dry-run, only propose?
                    if (proposeActionsJobId) {
                        await api.rawData.setSampleProposedChanges(project.id, sample.id, {
                            jobId: proposeActionsJobId,
                            proposedChanges: {
                                isDisabled: disableLabelsArgv.indexOf(json.label) > -1 ?
                                    true :
                                    undefined /* otherwise, keep the current state */,
                                label: json.label,
                                metadata: sample.metadata,
                            }
                        });
                    }
                    // actually perform actions
                    else {
                        if (disableLabelsArgv.indexOf(json.label) > -1) {
                            await api.rawData.disableSample(project.id, sample.id);
                        }

                        await api.rawData.editLabel(project.id, sample.id, { label: json.label });

                        await api.rawData.setSampleMetadata(project.id, sample.id, {
                            metadata: sample.metadata,
                        });
                    }
                }, {
                    fnName: 'edgeimpulse.api',
                    maxRetries: 3,
                    timeoutMs: 60000,
                    onWarning: (retriesLeft, ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] WARN: Failed to update metadata for ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}. Retries left=${retriesLeft}`);
                    },
                    onError: (ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] ERR: Failed to update metadata for ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}.`);
                    },
                });

                if (!labelCount[json.label]) {
                    labelCount[json.label] = 0;
                }
                labelCount[json.label]++;
            }
            catch (ex2) {
                let ex = <Error>ex2;
                let currFile = (processed + 1).toString().padStart(total.toString().length, ' ');
                console.log(`[${currFile}/${total}] Failed to label sample "${sample.filename}" (ID: ${sample.id}): ` +
                    (ex.message || ex.toString()));
                error++;
            }
            finally {
                processed++;
            }
        };

        try {
            console.log(`Labeling ${total.toLocaleString()} samples...`);

            await asyncPool(concurrencyArgv, samplesToProcess.slice(0, total), labelSampleWithOpenAI);

            clearInterval(updateIv);

            console.log(`[${total}/${total}] Labeling samples... ` + getSummary());
            console.log(`Done labeling samples!`);
            console.log(``);
            console.log(`OpenAI usage info:`);
            console.log(`    Model = ${model}`);
            console.log(`    Input tokens = ${promptTokensTotal.toLocaleString()}`);
            console.log(`    Output tokens = ${completionTokensTotal.toLocaleString()}`);
        }
        finally {
            clearInterval(updateIv);
        }
    }
    catch (ex2) {
        let ex = <Error>ex2;
        console.log('Failed to label data:', ex.message || ex.toString());
        process.exit(1);
    }

    process.exit(0);
})();

async function listAllUnlabeledData(projectId: number) {
    const limit = 1000;
    let offset = 0;
    let allSamples: models.Sample[] = [];

    let iv = setInterval(() => {
        console.log(`Still finding unlabeled data (found ${allSamples.length} samples)...`);
    }, 3000);

    try {
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'training',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (s.label === '' && s.chartType === 'image') {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }

        offset = 0;
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'testing',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (s.label === '' && s.chartType === 'image') {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }
    }
    finally {
        clearInterval(iv);
    }
    return allSamples;
}

async function listDataByIds(projectId: number, ids: number[]) {
    const limit = 1000;
    let offset = 0;
    let allSamples: models.Sample[] = [];

    let iv = setInterval(() => {
        console.log(`Still finding data (found ${allSamples.length} samples)...`);
    }, 3000);

    try {
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'training',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (ids.indexOf(s.id) !== -1) {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }

        offset = 0;
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'testing',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (ids.indexOf(s.id) !== -1) {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }
    }
    finally {
        clearInterval(iv);
    }
    return allSamples;
}

async function listAllVideos(projectId: number) {
    const limit = 1000;
    let offset = 0;
    let allSamples: models.Sample[] = [];

    let iv = setInterval(() => {
        console.log(`Still listing videos (found ${allSamples.length} samples)...`);
    }, 3000);

    try {
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'training',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (s.chartType === 'video' && !s.isProcessing) {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }
        while (1) {
            let ret = await api.rawData.listSamples(projectId, {
                category: 'testing',
                labels: '',
                offset: offset,
                limit: limit,
            });
            if (ret.samples.length === 0) {
                break;
            }
            for (let s of ret.samples) {
                if (s.chartType === 'video' && !s.isProcessing) {
                    allSamples.push(s);
                }
            }
            offset += limit;
        }
    }
    finally {
        clearInterval(iv);
    }
    return allSamples;
}


export async function retryWithTimeout<T>(fn: () => Promise<T>, opts: {
    fnName: string,
    timeoutMs: number,
    maxRetries: number,
    onWarning: (retriesLeft: number, ex: Error) => void,
    onError: (ex: Error) => void,
}) {
    const { timeoutMs, maxRetries, onWarning, onError } = opts;

    let retriesLeft = maxRetries;

    let ret: T;

    while (1) {
        try {
            ret = await new Promise<T>(async (resolve, reject) => {
                let timeout = setTimeout(() => {
                    reject(opts.fnName + ' did not return within ' + timeoutMs + 'ms.');
                }, timeoutMs);

                try {
                    const b = await fn();

                    resolve(b);
                }
                catch (ex) {
                    reject(ex);
                }
                finally {
                    clearTimeout(timeout);
                }
            });

            break;
        }
        catch (ex2) {
            let ex = <Error>ex2;

            retriesLeft = retriesLeft - 1;
            if (retriesLeft === 0) {
                onError(ex);
                throw ex2;
            }

            onWarning(retriesLeft, ex);
        }
    }

    return ret!;
}
