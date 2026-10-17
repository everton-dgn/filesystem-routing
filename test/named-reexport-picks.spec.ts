import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { build, createServer, type Plugin, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { toPickId, treeShake } from "../src/vite/tree-shake.ts";

// Characterization and executable issue evidence, not a production fix.
// Set EXPECT_TRANSITIVE_PICK=1 to run the desired isolation assertion against
// the current implementation (it fails in dev SSR and client/SSR builds).
const expectTransitivePick = process.env.EXPECT_TRANSITIVE_PICK === "1";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function fixture(target = "wrapper.tsx", picks = ["route"]) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".named-reexport-"));
  directories.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module", sideEffects: true }),
    "registry.ts": `
      export const events = [];
      export function register() { events.push("register"); return { title: "metadata" }; }
    `,
    "dependency.ts": `
      import { events } from "./registry.ts";
      events.push("component-dependency");
      export const component = () => "component";
    `,
    "side.ts": `import { events } from "./registry.ts"; events.push("explicit-side-effect");`,
    "page.css": `.reexport-evidence { color: red; }`,
    "page.tsx": `
      import { component } from "./dependency.ts";
      import { events, register } from "./registry.ts";
      import "./side.ts";
      import "./page.css";
      events.push("page-body");
      export const route = register();
      export const other = "other";
      export default () => component();
    `,
    "wrapper.tsx": `export { default, route } from "./page.tsx";`,
    "aliases.tsx": `export { default as Page, route as config, route as second } from "./page.tsx";`,
    "aliases-entry.ts": `
      import { Page, config, second } from ${JSON.stringify(
        toPickId("./aliases.tsx", ["Page", "config", "second", "$css"])
      )};
      export const same = config === second;
      export const rendered = Page();
    `,
    "entry.ts": `
      import { route } from ${JSON.stringify(toPickId(`./${target}`, picks))};
      import { events } from "./registry.ts";
      export { route, events };
      console.log(route, events);
    `,
    "identity.ts": `
      import { route as picked } from ${JSON.stringify(toPickId("./wrapper.tsx", ["route"]))};
      import { route as whole } from "./page.tsx";
      import { events } from "./registry.ts";
      export const same = picked === whole;
      export { events };
    `
  };
  for (const [file, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

// Deliberately fixture-specific counterexample to an unconditional source
// rewrite. It is not an implementation proposed for the shipping plugin.
function propagateFixturePick(): Plugin {
  return {
    name: "test-only:propagate-fixture-pick",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("/wrapper.tsx?pick=route")) {
        return code.replace('"./page.tsx"', JSON.stringify(toPickId("./page.tsx", ["route"])));
      }
    }
  };
}

function splitMetadataFixture() {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "metadata.ts"),
    'import { register } from "./registry.ts"; export const route = register();'
  );
  fs.writeFileSync(
    path.join(root, "wrapper.tsx"),
    'export { default } from "./page.tsx"; export { route } from "./metadata.ts";'
  );
  const page = path.join(root, "page.tsx");
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, "utf8")
      .replace("export const route = register();", 'export { route } from "./metadata.ts";')
  );
  return root;
}

async function dev(root: string, entry = "/entry.ts", propagate = false) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [propagate && propagateFixturePick(), treeShake()],
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  try {
    const result = await server.ssrLoadModule(entry);
    const wrapper = await server.transformRequest(toPickId("/wrapper.tsx", ["route"]));
    const page = await server.transformRequest(toPickId("/page.tsx", ["route"]));
    return { result, wrapper: wrapper!.code, page: page!.code };
  } finally {
    await server.close();
  }
}

async function bundle(root: string, ssr: boolean, entry = "entry.ts", propagate = false) {
  const result = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [propagate && propagateFixturePick(), treeShake()],
    build: {
      ssr,
      write: false,
      minify: false,
      rollupOptions: { input: path.join(root, entry) }
    }
  })) as Rollup.RollupOutput;
  const chunks = result.output.filter((item): item is Rollup.OutputChunk => item.type === "chunk");
  expect(chunks).toHaveLength(1);
  return { code: chunks[0].code, output: result.output };
}

async function executeBundle(code: string, root: string) {
  // Execute the real SSR output in Node, outside Vitest's module runner.
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${root}`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.argv[1]); console.log(JSON.stringify({ same: m.same, events: m.events }));",
        url
      ],
      { encoding: "utf8" }
    )
  );
}

describe("named reexport pick boundary", () => {
  it("dev SSR loads component dependencies through a reexport, but not a direct pick", async () => {
    const direct = await dev(fixture("page.tsx"));
    const reexport = await dev(fixture());
    expect(direct.result.events).toEqual(["explicit-side-effect", "page-body", "register"]);
    expect(reexport.result.route).toEqual(direct.result.route);
    expect(reexport.result.events.includes("component-dependency")).toBe(!expectTransitivePick);
    expect(reexport.wrapper).toContain('/page.tsx"');
    expect(reexport.wrapper).not.toContain("page.tsx?pick=");
    expect(direct.page).not.toContain("dependency.ts");
    expect(direct.page).not.toContain("page.css");
  });

  it.each([false, true])("build (SSR=%s) preserves the same dependency boundary", async ssr => {
    const direct = await bundle(fixture("page.tsx"), ssr);
    const reexport = await bundle(fixture(), ssr);
    expect(direct.code).not.toContain("component-dependency");
    expect(reexport.code.includes("component-dependency")).toBe(!expectTransitivePick);
    expect(direct.code).toContain("explicit-side-effect");
    expect(reexport.code).toContain("explicit-side-effect");
    if (!ssr) {
      expect(direct.output.some(item => item.fileName.endsWith(".css"))).toBe(false);
      expect(reexport.output.some(item => item.fileName.endsWith(".css"))).toBe(true);
    }
  });

  it.each([false, true])(
    "dev SSR: source propagation=%s controls module identity",
    async propagate => {
      const { result } = await dev(fixture(), "/identity.ts", propagate);
      expect(result.same).toBe(!propagate);
      expect(result.events.filter((event: string) => event === "register")).toHaveLength(
        propagate ? 2 : 1
      );
      expect(result.events.filter((event: string) => event === "page-body")).toHaveLength(
        propagate ? 2 : 1
      );
    }
  );

  it.each([false, true])(
    "built SSR: source propagation=%s controls module identity",
    async propagate => {
      const root = fixture();
      const { code } = await bundle(root, true, "identity.ts", propagate);
      const result = await executeBundle(code, root);
      expect(result.same).toBe(!propagate);
      expect(result.events.filter((event: string) => event === "register")).toHaveLength(
        propagate ? 2 : 1
      );
    }
  );

  it("a fixture-specific rewrite isolates metadata but retains explicit side effects", async () => {
    const { result } = await dev(fixture(), "/entry.ts", true);
    expect(result.events).toEqual(["explicit-side-effect", "page-body", "register"]);
  });

  it("dev SSR preserves alias bindings when selecting multiple names", async () => {
    const { result } = await dev(fixture(), "/aliases-entry.ts");
    expect(result.same).toBe(true);
    expect(result.rendered).toBe("component");
  });

  it("a direct metadata pick with $css keeps CSS without the component dependency", async () => {
    const { code, output } = await bundle(fixture("page.tsx", ["route", "$css"]), false);
    expect(code).not.toContain("component-dependency");
    expect(output.some(item => item.fileName.endsWith(".css"))).toBe(true);
  });

  it("separate metadata isolates dev loading and preserves identity with the whole page", async () => {
    const isolated = await dev(splitMetadataFixture());
    expect(isolated.result.events).toEqual(["register"]);
    const { result } = await dev(splitMetadataFixture(), "/identity.ts");
    expect(result.same).toBe(true);
    expect(result.events.filter((event: string) => event === "register")).toHaveLength(1);
  });

  it("separate metadata isolates client build and preserves built SSR identity", async () => {
    const isolated = await bundle(splitMetadataFixture(), false);
    expect(isolated.code).not.toContain("component-dependency");
    expect(isolated.output.some(item => item.fileName.endsWith(".css"))).toBe(false);
    const root = splitMetadataFixture();
    const { code } = await bundle(root, true, "identity.ts");
    const result = await executeBundle(code, root);
    expect(result.same).toBe(true);
    expect(result.events.filter((event: string) => event === "register")).toHaveLength(1);
  });

  it("preserves aliases, multiple picks and an existing source query", async () => {
    const plugin = treeShake() as any;
    const result = await plugin.transform(
      'export { default as Page, route as config, other } from "./page.tsx?custom=1";',
      toPickId("/wrapper.tsx", ["Page", "config", "$css"])
    );
    expect(result.code).toContain("default as Page");
    expect(result.code).toContain("route as config");
    expect(result.code).not.toContain("other");
    expect(result.code).toContain('from "./page.tsx?custom=1"');
  });

  it("leaves export-star unchanged", async () => {
    const plugin = treeShake() as any;
    const result = await plugin.transform(
      'export * from "./page.tsx";',
      toPickId("/wrapper.tsx", ["route"])
    );
    expect(result.code).toBe('export * from "./page.tsx";');
  });
});
