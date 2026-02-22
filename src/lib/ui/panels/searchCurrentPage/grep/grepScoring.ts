const SCORE_CONSECUTIVE = 8;
const SCORE_WORD_BOUNDARY = 10;
const SCORE_START = 6;
const SCORE_BASE = 1;
const PENALTY_DISTANCE = -1;

const WORD_SEPARATORS = new Set([" ", "-", "_", ".", "/", "\\", ":", "(", ")"]);

function scoreTerm(term: string, candidate: string): number | null {
  const termLen = term.length;
  const candidateLen = candidate.length;
  if (termLen === 0) return 0;
  if (termLen > candidateLen) return null;

  let score = 0;
  let termIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < candidateLen && termIdx < termLen; i++) {
    if (candidate[i] !== term[termIdx]) continue;

    score += SCORE_BASE;

    if (i === prevMatchIdx + 1) {
      score += SCORE_CONSECUTIVE;
    }

    if (i === 0) {
      score += SCORE_START;
    } else {
      const prev = candidate[i - 1];
      if (WORD_SEPARATORS.has(prev)) {
        score += SCORE_WORD_BOUNDARY;
      }
    }

    if (prevMatchIdx >= 0) {
      const gap = i - prevMatchIdx - 1;
      if (gap > 0) {
        score += gap * PENALTY_DISTANCE;
      }
    }

    prevMatchIdx = i;
    termIdx++;
  }

  if (termIdx < termLen) return null;
  return score;
}

export function fuzzyMatch(query: string, candidate: string): number | null {
  const terms = query.split(" ");
  let totalScore = 0;

  for (const term of terms) {
    if (!term) continue;
    const termScore = scoreTerm(term, candidate);
    if (termScore === null) return null;
    totalScore += termScore;
  }

  return totalScore;
}
