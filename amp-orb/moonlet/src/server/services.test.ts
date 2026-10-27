import { expect, test } from "bun:test";
import { parseServices } from "./services.ts";

test("services.yaml in Amp's format", () => {
	const specs = parseServices(`services:
  web:
    command: npm run dev -- --port $PORT
    cwd: app
    health: /
    env:
      API_URL: \${services.api.publicURL}
  api:
    command: bun api.ts
    port: 8787
    portal: false
  mac-only:
    command: open -a Simulator
    platforms: [darwin]
`);
	expect(specs.map((spec) => spec.name)).toEqual(["web", "api"]);
	expect(specs[0]).toMatchObject({ cwd: "app", health: "/", env: { API_URL: "${services.api.publicURL}" } });
	expect(specs[1]).toMatchObject({ port: 8787, portal: false });
});
