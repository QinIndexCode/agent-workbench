# Knowledge

Knowledge stores reusable notes and imported references that Agent Workbench may search later.

## Use Knowledge for

- design notes
- architecture facts
- imported documents that should be searchable
- stable explanations that may help later tasks

## Do not confuse this with live source state

`knowledge_search` looks at saved library content, not the current workspace files. When you must verify the current source tree, use live file tools.

## Advanced retrieval

The **Advanced** section lets you download local retrieval assets such as fastText vectors and the tiny ONNX reranker.

Use that only after:

1. your content is already clean
2. your tags are useful
3. you have a real retrieval-quality problem to solve
