# @int3gra/engine

The int3gra runtime engine. Loads, validates, and executes integration component JSON files.

## Part of int3gra

int3gra is a configuration-driven integration platform. Each integration is a directory of JSON component files — connections, maps, and processes — with JavaScript resolver modules for anything JSON can't express. The engine is stock and never changes between integrations; all domain knowledge lives in configuration.

## Installation

```bash
npm install -g @int3gra/engine @int3gra/cli @int3gra/manager
```

## Usage

The engine is primarily invoked by the CLI and manager, not directly. For programmatic use:

```javascript
import { boot } from "@int3gra/engine";

const result = await boot("/path/to/my-integration", {
  processId: "my-entry-process",
});
```

### Utility exports

```javascript
import { readManifest }                  from "@int3gra/engine";
import { validateManifest }              from "@int3gra/engine/loader";
import { resolveAuthHeaders, buildBasicAuthHeader,
         getOrRefreshToken }              from "@int3gra/engine/authUtilities";
import { receiveAttachment,
         prepareAttachmentUpload }        from "@int3gra/engine/binaryUtilities";
import { createStorage }                 from "@int3gra/engine/storage";
import { resolveAuthBlock }              from "@int3gra/engine/executor";
```

## Links

- [Documentation & full README](https://github.com/ciacob/integra#readme)
- [GitHub](https://github.com/ciacob/integra)
- [npm — @int3gra/cli](https://www.npmjs.com/package/@int3gra/cli)
- [npm — @int3gra/manager](https://www.npmjs.com/package/@int3gra/manager)

## License

BSL 1.1 — free to use commercially as a component of your own products. May not be resold or repackaged as a standalone product. Converts to Apache 2.0 on 2030/12/31. See LICENSE and NOTICE for details.
