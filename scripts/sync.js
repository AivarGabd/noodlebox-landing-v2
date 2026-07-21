/**
 * Синхронизирует posts.json и videos.json с папкой видео.
 *
 * Папка — источник истины. Скрипт идемпотентный: существующие записи никогда
 * не перезаписываются, дописываются только новые файлы. Превью снимаются
 * только недостающие.
 *
 * В отличие от первого проекта, запись опознаётся по ИМЕНИ ФАЙЛА, а не по
 * позиции в массиве: в этой папке имена произвольные ('v21.mp4', '22282_1.mp4')
 * и сплошной нумерации нет. Номер поста выдаётся один раз при добавлении и
 * дальше не меняется, поэтому скрытие поста не сдвигает остальные.
 *
 * Запуск:  node scripts/sync.js
 *          node scripts/sync.js --force-thumbs   пересобрать все превью
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC =
  process.env.VIDEO_DIR || "C:/Users/aivar/Documents/Adobe/Premiere Pro/26.0/v2";

const ROOT = path.join(__dirname, "..");
const THUMBS = path.join(ROOT, "public/thumbs");
const POSTS = path.join(ROOT, "posts.json");
const VIDEOS = path.join(ROOT, "videos.json");
const forceThumbs = process.argv.includes("--force-thumbs");

// --- 1. читаем папку -------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error("Папка с видео не найдена: " + SRC);
  process.exit(1);
}

const files = fs
  .readdirSync(SRC)
  .filter((f) => f.toLowerCase().endsWith(".mp4"))
  .map((file) => ({ file, mtime: fs.statSync(path.join(SRC, file)).mtimeMs }))
  // Порядок добавления — от старых к новым, чтобы номера шли по хронологии.
  .sort((a, b) => a.mtime - b.mtime)
  .map((x) => x.file);

if (!files.length) {
  console.error("В папке нет .mp4");
  process.exit(1);
}

// Имя файла → имя превью. 'post (59).mp4' → 'post-59', '22282_1.mp4' → '22282_1'.
function slugify(file) {
  return file
    .replace(/\.mp4$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

const slugs = new Map();
for (const file of files) {
  let slug = slugify(file) || "video";
  // Два разных файла не должны делить одно превью.
  if (slugs.has(slug)) {
    let i = 2;
    while (slugs.has(slug + "-" + i)) i++;
    slug = slug + "-" + i;
  }
  slugs.set(slug, file);
}
const slugByFile = new Map([...slugs].map(([slug, file]) => [file, slug]));

// --- 2. posts.json ---------------------------------------------------------

const posts = fs.existsSync(POSTS)
  ? JSON.parse(fs.readFileSync(POSTS, "utf8"))
  : [];

const known = new Map(posts.map((p) => [p.file, p]));

const added = [];
for (const file of files) {
  if (known.has(file)) continue;
  const post = {
    file,
    img: "public/thumbs/" + slugByFile.get(file) + ".jpg",
    url: "",
    isRemoved: false,
  };
  posts.push(post);
  known.set(file, post);
  added.push(file);
}

// Файл мог быть удалён или переименован — помечаем, но запись не выбрасываем,
// чтобы не потерять уже проставленную ссылку.
const present = new Set(files);
const orphans = posts.filter((p) => !present.has(p.file));

fs.writeFileSync(POSTS, JSON.stringify(posts, null, 4) + "\n");

// --- 3. превью -------------------------------------------------------------

fs.mkdirSync(THUMBS, { recursive: true });

let made = 0;
for (const file of files) {
  const out = path.join(THUMBS, slugByFile.get(file) + ".jpg");
  if (!forceThumbs && fs.existsSync(out)) continue;
  try {
    // -ss 1 до -i: отступаем от начала, иначе часто ловится чёрный кадр.
    // thumbnail=50 выбирает самый показательный кадр из следующих 50.
    execFileSync(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", "1",
        "-i", path.join(SRC, file),
        "-vf", "thumbnail=50,scale=400:-2",
        "-frames:v", "1",
        "-q:v", "4",
        "-y", out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    made++;
    console.log("превью: " + path.basename(out));
  } catch (err) {
    console.error("не удалось снять превью для " + file);
    console.error("  " + String(err.stderr || err.message).trim());
  }
}

// --- 4. videos.json (страница ревизии) -------------------------------------

const videos = files.map((file) => {
  const st = fs.statSync(path.join(SRC, file));
  const p = known.get(file);
  return {
    // Номер поста = позиция записи в posts.json.
    num: posts.indexOf(p) + 1,
    file,
    img: p.img,
    url: p.url || null,
    isRemoved: p.isRemoved,
    sizeMb: +(st.size / 1048576).toFixed(1),
    modified: st.mtime.toISOString().slice(0, 16).replace("T", " "),
  };
});

fs.writeFileSync(VIDEOS, JSON.stringify(videos, null, 4) + "\n");

// --- итог ------------------------------------------------------------------

const noUrl = videos.filter((v) => !v.url);

console.log("");
console.log("видео в папке:    " + files.length);
console.log("новых превью:     " + made);
console.log("добавлено:        " + (added.length ? added.join(", ") : "нет"));
console.log(
  "без ссылки:       " +
    (noUrl.length ? noUrl.length + " → " + noUrl.map((v) => v.file).join(", ") : "нет")
);
if (orphans.length) {
  console.log("");
  console.log("В posts.json есть записи, которым больше нет файла в папке:");
  orphans.forEach((p) => console.log("  #" + (posts.indexOf(p) + 1) + " " + p.file));
}
