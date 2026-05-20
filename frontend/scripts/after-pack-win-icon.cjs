/**
 * electron-builder 在 win.signAndEditExecutable=true 时会拉取并解压 winCodeSign；
 * 在部分 Windows 环境（未开开发者模式等）7za 无法创建包内符号链接会失败。
 * 打包阶段保持 signAndEditExecutable=false，在此处仅用 rcedit 写入 .exe 图标。
 */
const fs = require("fs");
const path = require("path");
const rcedit = require("rcedit");

module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;

  const icoPath = path.join(__dirname, "..", "build", "icon.ico");
  if (!fs.existsSync(icoPath)) {
    console.warn("[afterPack] build/icon.ico missing, skip rcedit");
    return;
  }

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(exePath)) {
    console.warn("[afterPack] exe not found, skip rcedit:", exePath);
    return;
  }

  console.log("[afterPack] applying Windows icon:", exePath);
  await rcedit(exePath, { icon: icoPath });
};
