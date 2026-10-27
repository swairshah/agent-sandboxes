#!/usr/bin/env bun
// Entry point of the binary orbs download: only what runs inside an orb.
import { runBootstrap } from "./bootstrap.ts";
import { VERSION } from "./protocol.ts";

const command = process.argv[2];
if (command === "bootstrap") {
	runBootstrap().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
} else {
	console.log(command === "version" || command === "--version" ? VERSION : "usage: moonlet bootstrap");
	if (command !== "version" && command !== "--version") process.exit(1);
}
