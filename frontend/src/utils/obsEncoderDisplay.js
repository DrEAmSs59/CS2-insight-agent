const INVALID_ENCODERS = new Set(["", "none", "null", "stream"]);

export function obsEncoderIsConfigured(value) {
  return !INVALID_ENCODERS.has(String(value ?? "").trim().toLowerCase());
}

export function obsEncoderIsHardware(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  return ["nvenc", "qsv", "amf", "amd"].some((marker) => lower.includes(marker));
}

export function formatObsEncoderLabel(value, unknownLabel = "Unknown") {
  const raw = String(value ?? "").trim();
  if (!obsEncoderIsConfigured(raw)) return unknownLabel;

  const lower = raw.toLowerCase();
  if (lower.includes("nvenc")) {
    if (lower.includes("av1")) return "NVIDIA NVENC AV1";
    if (lower.includes("hevc") || lower.includes("h265")) return "NVIDIA NVENC HEVC";
    return "NVIDIA NVENC H.264";
  }
  if (lower.includes("qsv")) {
    if (lower.includes("av1")) return "Intel QSV AV1";
    if (lower.includes("hevc") || lower.includes("h265")) return "Intel QSV HEVC";
    return "Intel QSV H.264";
  }
  if (lower.includes("amf") || lower.startsWith("amd")) {
    if (lower.includes("av1")) return "AMD AMF AV1";
    if (lower.includes("hevc") || lower.includes("h265")) return "AMD AMF HEVC";
    return "AMD AMF H.264";
  }
  if (lower.includes("x264")) return "x264";
  return raw;
}
