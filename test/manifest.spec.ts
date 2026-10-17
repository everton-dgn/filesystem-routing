import { describe, expect, it } from "vitest";

import { getRouteModuleRefs, type ModuleRef, type RouteManifestEntry } from "../src/index.ts";

describe("getRouteModuleRefs", () => {
  it("keeps ref keys, order and identity without deduplicating source modules", () => {
    const component: ModuleRef = { src: "/routes/users.tsx", pick: ["default"] };
    const config: ModuleRef = { src: component.src, pick: ["route"] };
    const handler: ModuleRef = { src: component.src, pick: ["GET"], eager: true };
    const entry: RouteManifestEntry = Object.freeze({
      path: "/users",
      page: true,
      $component: component,
      $$route: config,
      $GET: handler,
      $POST: undefined,
      metadata: { src: "/metadata.ts", pick: ["default"] }
    });

    const refs = getRouteModuleRefs(entry);

    expect(refs).toEqual([
      ["$component", component],
      ["$$route", config],
      ["$GET", handler]
    ]);
    expect(refs[0]![1]).toBe(component);
    expect(refs[1]![1]).toBe(config);
    expect(refs[2]![1]).toBe(handler);
  });

  it("returns no refs for an entry with only metadata or absent refs", () => {
    expect(
      getRouteModuleRefs({ path: "/", $component: undefined, $$route: undefined, $GET: null })
    ).toEqual([]);
  });

  it("only visits direct refs in the neutral entry", () => {
    const ref: ModuleRef = { src: "/routes/child.tsx", pick: ["default"] };
    expect(
      getRouteModuleRefs({ path: "/", children: [{ path: "/child", $component: ref }] })
    ).toEqual([]);
  });
});
