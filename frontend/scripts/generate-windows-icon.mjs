/**
 * 从 public/cs2-insight-logo.png 生成 build/icon.ico，供 NSIS 安装程序与桌面快捷方式使用。
 * png-to-ico 要求源 PNG 宽高严格相等，先对非方形 logo 做居中裁切。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import pngToIco from "png-to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const pngPath = path.join(root, "public", "cs2-insight-logo.png");
const outDir = path.join(root, "build");
const icoPath = path.join(outDir, "icon.ico");

if (!fs.existsSync(pngPath)) {
  console.error("[icon] Missing:", pngPath);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

/**
 * @param {Buffer} input
 * @returns {Buffer} PNG bytes with width === height
 */
function centerSquarePngBuffer(input) {
  const src = PNG.sync.read(input);
  if (src.width === src.height) return input;

  const side = Math.min(src.width, src.height);
  const ox = Math.floor((src.width - side) / 2);
  const oy = Math.floor((src.height - side) / 2);
  const dst = new PNG({ width: side, height: side });

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const si = ((y + oy) * src.width + (x + ox)) << 2;
      const di = (y * side + x) << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }

  return PNG.sync.write(dst);
}

try {
  const raw = fs.readFileSync(pngPath);
  const square = centerSquarePngBuffer(raw);
  const buf = await pngToIco(square);
  fs.writeFileSync(icoPath, buf);
  console.log("[icon] wrote", icoPath);
} catch (err) {
  console.error("[icon] png-to-ico failed:", err);
  process.exit(1);
}
