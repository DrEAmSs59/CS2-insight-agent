import axios from "axios";

/**
 * Calls POST /api/recording/plan with a RecordingRequestDTO.
 * Returns a RecordingPlan on success.
 * Throws an AxiosError (or re-throws) on failure.
 * @param {import("./types.js").RecordingRequestDTO} dto
 * @returns {Promise<import("./types.js").RecordingPlan>}
 */
export async function fetchRecordingPlan(dto) {
  const response = await axios.post("/api/recording/plan", dto);
  return response.data;
}
