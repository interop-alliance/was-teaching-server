# Design documents

This directory holds this repo's design-gate documents, one per cross-cutting
roadmap item (an item whose `design:` field names a doc here). The convention,
the gate's mechanics, and the document template are canonical in
[isomorphic-lib-template's `designs/`](https://github.com/interop-alliance/isomorphic-lib-template/tree/main/designs);
copy its `TEMPLATE.md` for a new doc (`WAS-N-slug.md`). A design doc is a
working artifact: at approval its durable decisions are extracted into
[`decisions/`](../decisions/) records, and once the item lands,
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the resulting shape.
