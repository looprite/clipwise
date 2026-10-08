// Every HTTP route on the app, found by walking it rather than by reading a
// list someone maintains — so a route added without being classified shows up.
//
// Routers must be mounted through buildApp()'s `mount`, which records them;
// a router on the app that is not in that record, or nested inside another
// router, is an error here rather than a route that quietly goes unlisted.

import type { Express } from "express";
import type { Mount } from "../app.js";

export type ListedRoute = { method: string; path: string };

type Layer = {
  name?: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
};

function methodsOf(route: { methods: Record<string, boolean> }): string[] {
  // Express 4 expands `app.all(...)` into one route entry per HTTP verb (35 of
  // them), so a route that answers more than a handful of methods is "ALL".
  const methods = Object.keys(route.methods).filter((m) => m !== "_all");
  if (route.methods._all || methods.length > 10) return ["ALL"];
  return methods.map((m) => m.toUpperCase());
}

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix === "/" ? "" : prefix}${path === "/" ? "" : path}`;
  return joined === "" ? "/" : joined;
}

export function listRoutes(app: Express, mounts: Mount[]): ListedRoute[] {
  const out: ListedRoute[] = [];
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  for (const layer of stack) {
    if (layer.route) {
      for (const method of methodsOf(layer.route)) out.push({ method, path: layer.route.path });
    } else if (layer.name === "router") {
      const mount = mounts.find((m) => m.router === (layer.handle as unknown));
      if (!mount) throw new Error("a Router is mounted on the app without being recorded by buildApp()'s mount()");
      for (const sub of (layer.handle as { stack: Layer[] }).stack) {
        if (sub.route) {
          for (const method of methodsOf(sub.route)) out.push({ method, path: joinPath(mount.prefix, sub.route.path) });
        } else if (sub.name === "router") {
          throw new Error(`a Router nested inside the router mounted at ${mount.prefix} is not supported by the route list`);
        }
      }
    }
  }
  return out;
}
