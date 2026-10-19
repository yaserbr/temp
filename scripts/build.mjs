// Production build for the QA Lite frontend: validates web/ and copies it to dist/.
// The app is plain HTML/CSS/JS, so there is nothing to compile - the build guarantees that every
// script parses and every local file referenced from the HTML pages exists.
import { execFileSync } from "node:child_process";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const source = resolve("web");
const output = resolve("dist");
const problems = [];

const files = (await readdir(source, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));

for (const file of files.filter((path) => extname(path) === ".js")) {
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (error) {
        problems.push(`Syntax error in ${file}:\n${error.stderr}`);
    }
}

for (const file of files.filter((path) => extname(path) === ".html")) {
    const html = await readFile(file, "utf8");
    for (const [, reference] of html.matchAll(/\s(?:src|href)="([^"#?]+)[^"]*"/g)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(reference)) {
            problems.push(`${file} references an external URL: ${reference}`);
        } else if (!existsSync(join(dirname(file), reference))) {
            problems.push(`${file} references a missing file: ${reference}`);
        }
    }
}

if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
}

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
console.log(`Build OK: ${files.length} files checked and copied to ${output}`);
