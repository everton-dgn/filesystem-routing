---
"filesystem-routing": patch
---

Remove a watched route by the file that added it. `removeRoute` looked the entry up with `toPath`, so saving or deleting a module that isn't a route removed a page with the same path (for example `about.ts` next to `about.tsx`), and the entry from a custom `toRoute` stayed in the manifest after its file was deleted. `BaseFileSystemRouter` configured with only `toRoute` threw `Not implemented` when a file was deleted. An edit that changes the path returned by `toRoute` now replaces the old entry instead of adding a second one.
