import API from "../api/api";

/**
 * @param {import("./types.js").RecordingRequestDTO} dto
 * @returns {Promise<{
 *   source: string,
 *   llm_error: string | null,
 *   rationale: string,
 *   blocks: Array<{ type: string, label: string, kill_indices?: number[], kill_index?: number }>,
 *   preview_lines: string[],
 *   estimated_segments: number,
 *   victim_pov_count: number,
 *   kill_count: number,
 * }>}
 */
export async function fetchAiDirectorPreview(dto) {
  const response = await API.post("/recording/ai-director/preview", dto);
  return response.data;
}
