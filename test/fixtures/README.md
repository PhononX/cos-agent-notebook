# Test fixtures

`notebook/` is an invented notebook used by the tests. Every person, company, link and message in
it is made up; the links use `example.com`, `example.org` and other reserved example domains.
Never copy real notebook content here.

It covers every file type in `docs/notebook-format.md`, plus things people do when they edit by
hand, which the service must read without failing and write back byte for byte:

- `sources.md` uses Windows line endings (`\r\n`).
- `facts.md` has no newline at the end.
- `inbox.md` has a field with one colon, a field that isn't closed, and fields before the
  sentence.
- `actions.md` has an impossible due date, a `[X]` checkbox and a `*` list marker.
- `nudges.md` has two identical lines (their ids differ by occurrence number).
- `projects/Q4 Launch.md` has a tab-indented item and a list line inside a code fence.
- `drafts/.history/` holds an earlier draft version, which isn't read as a note.

`.gitattributes` keeps git from changing these files' line endings.
