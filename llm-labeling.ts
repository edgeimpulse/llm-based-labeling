import fs from 'fs';
import Path from 'path';
import program from 'commander';
import { EdgeImpulseApi } from 'edge-impulse-api';
import * as models from 'edge-impulse-api/build/library/sdk/model/models';
import OpenAI from "openai";
import asyncPool from 'tiny-async-pool';

const packageVersion = (<{ version: string }>JSON.parse(fs.readFileSync(
    Path.join(__dirname, '..', 'package.json'), 'utf-8'))).version;

if (!process.env.EI_PROJECT_API_KEY) {
    console.log('Missing EI_PROJECT_API_KEY');
    process.exit(1);
}
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
    .option('--limit <n>', `Max number of samples to process`)
    .option('--concurrency <n>', `Concurrency (default: 1)`)
    .option('--verbose', 'Enable debug logs')
    .allowUnknownOption(true)
    .parse(process.argv);

const api = new EdgeImpulseApi({ endpoint: API_URL });

const promptArgv = <string>program.prompt;
const disableLabelsArgv = (<string[]>(<string | undefined>program.disableLabels || '').split(',')).map(x => x.trim().toLowerCase()).filter(x => !!x);
const limitArgv = program.limit ? Number(program.limit) : undefined;
const concurrencyArgv = program.concurrency ? Number(program.concurrency) : 1;

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
        console.log(`    Limit no. of samples to label to: ${typeof limitArgv === 'number' ? limitArgv.toLocaleString() : 'No limit'}`);
        console.log(`    Concurrency: ${concurrencyArgv}`);
        console.log(``);

        console.log(`Finding unlabeled data...`);
        const unlabeledSamples = await listAllUnlabeledData(project.id);
        console.log(`Finding unlabeled data OK (found ${unlabeledSamples.length} samples)`);
        console.log(``);

        const total = typeof limitArgv === 'number' ?
            (unlabeledSamples.length > limitArgv ? limitArgv : unlabeledSamples.length) :
            unlabeledSamples.length;
        let processed = 0;
        let error = 0;
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

        const labelSampleWithOpenAI = async (sample: models.Sample) => {
            try {
                const resp = await retryWithTimeout(async () => {
                    const imgBuffer = await api.rawData.getSampleAsImage(project.id, sample.id, { });

                    return await openai.chat.completions.create({
                        model: 'gpt-4o-2024-05-13',
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
                                    detail: 'auto'
                                }
                            }]
                        }]
                    });
                }, {
                    fnName: 'completions.create',
                    maxRetries: 3,
                    onWarning: (retriesLeft, ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] WARN: Failed to label ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}. Retries left=${retriesLeft}`);
                    },
                    onError: (ex) => {
                        let currFile = (processed).toString().padStart(total.toString().length, ' ');
                        console.log(`[${currFile}/${total}] ERR: Failed to  ${sample.filename} (ID: ${sample.id}): ${ex.message || ex.toString()}.`);
                    },
                    timeoutMs: 60000,
                });

                if (resp.choices.length !== 1) {
                    throw new Error('Expected choices to have 1 item (' + JSON.stringify(resp) + ')');
                }
                if (resp.choices[0].message.role !== 'assistant') {
                    throw new Error('Expected choices[0].message.role to equal "assistant" (' + JSON.stringify(resp) + ')');
                }
                if (typeof resp.choices[0].message.content !== 'string') {
                    throw new Error('Expected choices[0].message.content to be a string (' + JSON.stringify(resp) + ')');
                }

                let json: { label: string, reason: string };
                try {
                    json = <{ label: string, reason: string }>JSON.parse(resp.choices[0].message.content);
                    if (typeof json.label !== 'string') {
                        throw new Error('label was not of type string');
                    }
                    if (typeof json.reason !== 'string') {
                        throw new Error('reason was not of type string');
                    }
                }
                catch (ex2) {
                    let ex = <Error>ex2;
                    throw new Error('Failed to parse message content: ' + (ex.message + ex.toString()) +
                        '(' + resp.choices[0].message.content + ')');
                }
                // console.log('resp', JSON.stringify(resp, null, 4));

                if (disableLabelsArgv.indexOf(json.label) > -1) {
                    await api.rawData.disableSample(project.id, sample.id);
                }

                await api.rawData.editLabel(project.id, sample.id, { label: json.label });

                // update metadata
                sample.metadata = sample.metadata || {};
                sample.metadata.reason = json.reason;

                await api.rawData.setSampleMetadata(project.id, sample.id, {
                    metadata: sample.metadata,
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

            await asyncPool(concurrencyArgv, unlabeledSamples.slice(0, total), labelSampleWithOpenAI);

            clearInterval(updateIv);

            console.log(`[${total}/${total}] Labeling samples... ` + getSummary());
            console.log(`Done labeling samples, goodbye!`);
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
                if (s.label === '') {
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
                if (s.label === '') {
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