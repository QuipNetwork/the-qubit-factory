# AGENTS.md

Project guidance for **The Qubit Factory** — a self-hosted fork of
`awslabs/the-qubit-factory`, deployed at https://qbf.quip.network. It adds
custom-circuit links (`#seed=…` / `#qasm=…`) handled client-side by
`scripts/qubit-factory-link.js`.

## License (repo-specific exception)

This repository is licensed **Apache-2.0**, inherited from the upstream
`awslabs/the-qubit-factory`. New source files use the Apache-2.0 SPDX header:

```js
/*
 * Copyright <year> Quip Network
 * SPDX-License-Identifier: Apache-2.0
 */
```

**This overrides the global default** (AGPL-3.0-or-later from the personal
`CLAUDE.md`). Keep this repo Apache-2.0 to stay license-compatible with the
upstream it tracks — do **not** add AGPL headers here.
