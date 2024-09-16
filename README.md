# Transformation block: LLM-based labeling with GPT4o

This is an Edge Impulse [transformation block](https://docs.edgeimpulse.com/docs/edge-impulse-studio/organizations/custom-blocks/transformation-blocks) that finds unlabeled image data in an Edge Impulse project, then asks GPT4o to label the data. You can use this repo as the basis for custom tasks that use LLMs to help with labeling or data quality tasks in your project.

## Use this from Edge Impulse (enterprise projects)

If you just want to use GPT4o as a labeling tool in your Edge Impulse project you don't need this repo. Just go to any project, select **Data sources > Add new data source**, choose **Transformation block > Label image data using GPT4o** (available for enterprise projects only).

## How to test locally

1. Create a new Edge Impulse project, and add some unlabeled images.
2. Import your API keys (both Edge Impulse and OpenAI):

    ```
    export OPENAI_API_KEY=sk-M...
    export EI_PROJECT_API_KEY=ei_44...
    ```

3. Install Node.js 20.
4. Build and run this project to label your data:

    ```
    npm run build
    node build/llm-labeling.js \
        --prompt "Are there airpods in this photo? If so, say 'yes'; if not, say 'no'; or if you're unsure say 'unsure'" \
        --disable-labels "unsure" \
        --concurrency 10
    ```

## Pushing block to Edge Impulse (enterprise only)

If you've modified this block, you can push it back to Edge Impulse so it's available to everyone in your organization.

1. Initialize the block:

    ```
    $ edge-impulse-blocks init

    ? Choose a type of block
        ❯ Transformation block
    ? Choose an option:
        ❯ Create a new block
    ? Enter the name of your block:
        Label image data using GPT-4o
    ? Enter the description of your block:
        This block takes all your unlabeled image files, and asks GPT-4o to label them. Your prompt should return a single label, e.g. "Is there a person in this picture? Answer with just 'yes' or 'no'." We automatically add the reasoning as metadata to your items.
    ? What type of data does this block operate on?
        ❯ Standalone (runs the container, but no files / data items passed in)
    ```

2. Push the block:

    ```
    $ edge-impulse-blocks push
    ```

3. Afterwards, you can run your block through **Data sources** in any Edge Impulse project.
