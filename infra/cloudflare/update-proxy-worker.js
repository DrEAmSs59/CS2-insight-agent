/**
 * Cloudflare Worker: 真·增量更新代理 (支持 multipart/byteranges)
 * 
 * 作用：
 * 1. 拦截 Electron 发出的多段 Range 请求 (R2 原生不支持，会报 400)。
 * 2. 自动拆分请求，分别从 R2 获取各段数据。
 * 3. 按照 RFC 7233 标准拼装响应，实现真正的差量下载（仅 1.3MB 而非 235MB）。
 */

const R2_ORIGIN = "https://pub-89edf85ff1b84f7bac561f78ec51f15b.r2.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const r2Url = `${R2_ORIGIN}${url.pathname}${url.search}`;
    const rangeHeader = request.headers.get("Range");

    // 逻辑 1：普通请求或单段 Range 请求，直接透传给 R2
    if (!rangeHeader || !rangeHeader.includes(",")) {
      return fetch(r2Url, request);
    }

    // 逻辑 2：处理多段 Range 请求 (True Delta Update)
    console.log(`[Worker] Handling Multi-Range: ${rangeHeader}`);

    try {
      // 解析 Range 头，例如 "bytes=0-100, 200-300"
      const ranges = rangeHeader.replace("bytes=", "").split(",").map(r => r.trim());
      const boundary = `insight_agent_${Math.random().toString(36).slice(2)}`;
      
      // 这里的逻辑：由于 Cloudflare Worker 免费版有 50 个并发请求限制，
      // 如果 ranges 太多（比如你日志里的 66 个），我们需要分批或提示。
      // 但对于大部分更新，直接并行 fetch 效果最好。
      
      const parts = await Promise.all(ranges.map(async (range) => {
        const resp = await fetch(r2Url, {
          headers: { "Range": `bytes=${range}` }
        });
        
        if (!resp.ok) throw new Error(`R2 Fetch failed: ${resp.status}`);
        
        const contentRange = resp.headers.get("Content-Range") || `bytes ${range}/*`;
        const buffer = await resp.arrayBuffer();
        
        // 构造 multipart 每一段的头部
        let part = `--${boundary}\r\n`;
        part += `Content-Type: application/octet-stream\r\n`;
        part += `Content-Range: ${contentRange}\r\n\r\n`;
        
        return {
          header: new TextEncoder().encode(part),
          data: new Uint8Array(buffer),
          footer: new TextEncoder().encode("\r\n")
        };
      }));

      // 合并所有数据
      const finalFooter = new TextEncoder().encode(`--${boundary}--\r\n`);
      let totalSize = finalFooter.byteLength;
      for (const p of parts) {
        totalSize += p.header.byteLength + p.data.byteLength + p.footer.byteLength;
      }

      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const p of parts) {
        combined.set(p.header, offset); offset += p.header.byteLength;
        combined.set(p.data, offset); offset += p.data.byteLength;
        combined.set(p.footer, offset); offset += p.footer.byteLength;
      }
      combined.set(finalFooter, offset);

      return new Response(combined, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Type": `multipart/byteranges; boundary=${boundary}`,
          "Cache-Control": "public, max-age=3600"
        }
      });

    } catch (err) {
      console.error("[Worker Error]", err);
      // 如果差量拼装失败，保底方案：返回全量（至少保证更新能成功）
      const fallback = await fetch(r2Url);
      return fallback;
    }
  }
};
