# Acceptance criteria

What a stage's deliverable must meet, written as data both sides agree to. The milestone's `evidence` text stays a description for people; an evaluator checks only these criteria.

```json
{
  "version": 1,
  "criteria": [
    { "id": "format",   "kind": "media-type", "anyOf": ["text/markdown", "text/plain"] },
    { "id": "length",   "kind": "words",      "min": 150, "max": 400 },
    { "id": "sections", "kind": "sections",   "headings": ["Summary", "Risks", "Obligations"] },
    { "id": "terms",    "kind": "contains",   "text": ["termination", "indemnity"] },
    { "id": "clean",    "kind": "excludes",   "text": ["lorem ipsum", "TODO"] },
    { "id": "risks",    "kind": "rubric",     "question": "Does the Risks section name every uncapped liability in the contract?" }
  ]
}
```

- `id`: lowercase letters, digits and dashes, unique, up to 40 characters.
- Up to 20 criteria. Texts up to 500 characters.

## Kinds

| Kind | Fields | Passes when |
|---|---|---|
| `media-type` | `anyOf`: `application/pdf`, `image/png`, `image/jpeg`, `application/zip`, `application/json`, `text/plain`, `text/markdown`, `text/csv` | The file's bytes are one of them. It is detected from content, never from a name; any UTF-8 text satisfies the text types. |
| `size` | `minBytes`, `maxBytes` (one or both) | The size is in range. |
| `json` | `requiredKeys` (optional; dot paths such as `items.0.id`) | The file is valid JSON with every key path. |
| `words` | `min`, `max` (one or both) | The word count of the text is in range. |
| `sections` | `headings` | Every heading appears as a line (Markdown `#` and a trailing colon are ignored; case-insensitive). |
| `contains` | `text`, `caseSensitive` (optional) | Every phrase appears (whitespace-normalized). |
| `excludes` | `text`, `caseSensitive` (optional) | No phrase appears. |
| `rubric` | `question` (one yes/no question) | A model answers yes **and** quotes the file word for word. A no fails; unsure, no model, or non-text files leave it to a person. |

Rule kinds that need text (`words`, `sections`, `contains`, `excludes`) return needs-human for PDFs and images: this evaluator does not extract text from them.

## Verdict

- `fail` if any criterion fails (`failedBy` is `rule` or `model`).
- Otherwise `needs-human` if any criterion is left to a person.
- Otherwise `pass`.

## Writing good criteria

- Prefer rule kinds: they are free to re-run and leave nothing to judgment.
- Use `rubric` for meaning that rules cannot check, one question per criterion, answerable from the file alone.
- Say in the listing description what the criteria mean for the buyer, so nobody is surprised.
