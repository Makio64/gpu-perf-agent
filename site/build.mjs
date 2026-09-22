import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
const root = new URL("./", import.meta.url);
const output = new URL("dist/", root);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", root), "utf8"),
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "index.html",
  "src/style.css",
  "src/main.js",
  "assets/mark.svg",
]) {
  const destination = new URL(file, output);
  await mkdir(new URL("./", destination), { recursive: true });
  const source = await readFile(new URL(file, root), "utf8");
  await writeFile(destination, source.replaceAll("__VERSION__", version));
}
await writeFile(new URL(".nojekyll", output), "");
console.log(`Built GPU Performance Agent ${version} → site/dist`);
