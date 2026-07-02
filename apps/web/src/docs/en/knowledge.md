# Knowledge

Knowledge stores reusable notes and imported references that Agent Workbench may search later. It belongs in the Library and is meant for stable background material, not as a replacement for live observation of the current task workspace.

## Use Knowledge for

- design notes
- architecture facts
- imported documents that should be searchable
- stable explanations that may help later tasks
- external-reference summaries, vendor behavior notes, and project runbooks

## Do not confuse this with live source state

`knowledge_search` looks at saved library content, not the current workspace files. When you must verify the current source tree, use live file tools.

## Entry points

- Web: open **Library → Knowledge** to create items, upload text-like files, filter by tag and status, and test retrieval results.
- Composer: `/knowledge` opens the Knowledge page; `/knowledge <question>` submits a request that should use `knowledge_search` when saved background material is needed.
- CLI: `aw knowledge list|add|upload|search|reindex|update|delete|models|download-model` uses the same server API and never writes SQLite directly.

## Project scope

Knowledge items carry a `projectId`. In a task, `knowledge_search` defaults to the current task folder's project scope. In the CLI, use `--project <id>` when you need a specific scope. Before sharing an item across projects, confirm it is truly stable global context.

## Index states

- `pending`: saved but not indexed yet
- `indexed`: available for retrieval
- `failed`: indexing failed and the content or reindex action needs attention
- `metadata_only`: content is empty or not indexable; title, tags, source, and other metadata remain searchable

When content changes, files are uploaded, or content is cleared, Agent Workbench rebuilds or cleans the matching search index. Batch reindexing is useful after imports or retrieval-quality checks; it should not be required before every task.

## Retrieval-quality checks

Use the page's **Search test** or `aw knowledge search "<query>" --json` to inspect actual hits, snippets, matched fields, retrieval grade, and confidence. If recall is poor, first improve titles, tags, source names, and stable keywords in the body, then consider local model assets.

## Intelligent retrieval

The retrieval layer builds a local query plan before using the same index and rerank pipeline. The default `auto` mode keeps the original question and adds normalized queries, code identifier splitting, common domain aliases, and step-back queries. For example, Chinese permission and approval questions can recall English `approval`, `permission`, and `grant` notes, and `load knowledge index` can match `loadKnowledgeIndex`.

These upgrades are deterministic local logic and do not add LLM calls, so they do not lower prompt-cache hit rates. When you need to debug recall, run `aw knowledge search "<query>" --diagnostics --json` to inspect query variants, the matched query, retrieval grade, and confidence. Use `--mode keyword` when you need stricter keyword matching.

## Advanced retrieval

The **Advanced** section lets you download local retrieval assets such as fastText vectors and the tiny ONNX reranker.

Use that only after:

1. your content is already clean
2. your tags are useful
3. you have a real retrieval-quality problem to solve
