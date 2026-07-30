# Third-party source

This tool vendors `source2-demo` 0.5.8 from
<https://github.com/Rupas1k/source2-demo> (crate source commit
`c9f91d90c7a49fd3a19d7c3bd5963b6d0f634b9f`). The upstream crate is licensed
under `MIT OR Apache-2.0`; both complete license texts are retained in
`vendor/source2-demo-0.5.8/`.

The vendored source differs from the published 0.5.8 crate only in these files:

- `src/parser/demo/writer/rewriter.rs`
- `src/parser/demo/writer/mod.rs`
- `src/parser/demo/writer/entity.rs`
- `src/parser/demo/writer/output.rs`
- `src/parser/demo/writer/runner.rs`
- `src/stream/field_path/codec.rs`

The local patch adds a narrowly scoped `append_entity_fields` writer hook. It
looks up fields already present in the serializer, preserves the original
field-path prefix, uses a parser-compatible initial transition for an empty
prefix, inserts new transitions before the finish marker, and emits the
original and appended values in one writer pass. It updates only that entity's
tracked state and does not edit shared instance baselines. The writer also
refreshes both indexed CS2 outer-header offsets after output size changes.

No DemoTracer source file is a build dependency of this project.
