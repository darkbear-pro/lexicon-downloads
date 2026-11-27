import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const site = "https://darkbear-pro.github.io/Lexicon/";
const repo = process.env.GH_REPO;
const gh = (...args) => exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
const releases = async () =>
  JSON.parse(
    (
      await gh(
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/releases?per_page=100`,
      )
    ).stdout,
  ).flat();
const tagPattern = /^v\d+\.\d+\.\d+(?:-qa\.\d+)?$/;
const patterns = {
  mac: /^Lexicon-(?:QA-\d+\.\d+\.\d+-macos-arm64|\d+\.\d+\.\d+-aarch64-apple-darwin)\.dmg$/,
  win: /^Lexicon-(?:QA-\d+\.\d+\.\d+-windows-x64|\d+\.\d+\.\d+-x86_64-pc-windows-msvc)\.exe$/,
};
const platforms = Object.keys(patterns);
const response = await fetch(site + "release.json", {
  headers: { "Cache-Control": "no-cache" },
});
if (!response.ok) throw Error(`Манифест сайта недоступен: ${response.status}`);
const { tag, files, digests } = await response.json();
if (
  !tagPattern.test(tag) ||
  !platforms.every(
    (os) =>
      patterns[os].test(files?.[os]) &&
      /^sha256:[a-f0-9]{64}$/.test(digests?.[os]),
  )
)
  throw Error("Некорректный манифест установщиков Lexicon");

const temporary = await mkdtemp(path.join(tmpdir(), "lexicon-mirror-"));
try {
  let current = (await releases()).find((release) => release.tag_name === tag);
  const pending = [];
  for (const os of platforms) {
    const filename = files[os];
    const existing = current?.assets.find((asset) => asset.name === filename);
    if (existing) {
      if (existing.state !== "uploaded" || existing.digest !== digests[os])
        throw Error(
          `Уже опубликованный файл отличается от манифеста: ${filename}`,
        );
      continue;
    }
    const file = path.join(temporary, filename);
    await exec("curl", [
      "-fsSL",
      "--retry",
      "3",
      "--max-time",
      "120",
      site + `downloads/${tag}/${filename}`,
      "-o",
      file,
    ]);
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (`sha256:${digest}` !== digests[os])
      throw Error(`Контрольная сумма не совпадает: ${filename}`);
    pending.push(file);
  }
  if (!current) {
    await gh(
      "release",
      "create",
      tag,
      "--draft",
      "--target",
      "main",
      "--title",
      `Lexicon ${tag.slice(1)}`,
      "--notes",
      `Установщики с [сайта Lexicon](${site}).`,
      ...(tag.includes("-qa.") ? ["--prerelease", "--latest=false"] : []),
    );
    current = (await releases()).find((release) => release.tag_name === tag);
    if (!current) throw Error("Черновик релиза не найден");
  }
  if (pending.length) await gh("release", "upload", tag, ...pending);
  if (current.draft) await gh("release", "edit", tag, "--draft=false");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const counts = { mac: 0, win: 0 };
const published = (await releases()).filter(
  (release) => !release.draft && tagPattern.test(release.tag_name),
);
for (const release of published) {
  for (const asset of release.assets) {
    const os = platforms.find((platform) =>
      patterns[platform].test(asset.name),
    );
    if (!os || asset.state !== "uploaded") continue;
    if (!Number.isSafeInteger(asset.download_count) || asset.download_count < 0)
      throw Error(`Некорректный счётчик установщика: ${asset.name}`);
    counts[os] += asset.download_count;
  }
}
const publishedRelease = published.find((release) => release.tag_name === tag);
if (
  !platforms.every((os) =>
    publishedRelease?.assets.some(
      (asset) =>
        asset.name === files[os] &&
        asset.state === "uploaded" &&
        asset.digest === digests[os],
    ),
  )
)
  throw Error(
    "В публичном релизе отсутствует проверенный комплект установщиков",
  );
await writeFile(
  "downloads.json",
  JSON.stringify({ tag, counts }, null, 2) + "\n",
);
