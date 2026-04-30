import { randomBytes } from 'node:crypto';

const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'cool', 'crisp', 'dawn', 'ember', 'fast',
  'fresh', 'gentle', 'icy', 'jolly', 'keen', 'lively', 'mellow', 'mild',
  'neat', 'nimble', 'nova', 'olive', 'plucky', 'quick', 'quiet', 'rapid',
  'sharp', 'silent', 'swift', 'tidy', 'urban', 'vivid', 'warm', 'wild',
  'young', 'zesty', 'bright', 'clear', 'deep', 'fair', 'grand', 'light',
  'noble', 'proud', 'rare', 'solid', 'stout', 'true', 'vast', 'wise',
];

const NOUNS = [
  'atlas', 'bloom', 'cedar', 'cloud', 'comet', 'coral', 'delta', 'echo',
  'falcon', 'glade', 'harbor', 'island', 'jade', 'koala', 'lake', 'meadow',
  'nebula', 'oak', 'pine', 'quartz', 'reef', 'spruce', 'tundra', 'vale',
  'willow', 'yew', 'zephyr', 'arch', 'bay', 'cliff', 'dune', 'fern',
  'grove', 'hive', 'iris', 'lynx', 'marsh', 'ridge', 'stone', 'tower',
  'brooke', 'cove', 'frost', 'hawk', 'lark', 'moss', 'peak', 'shade',
];

/**
 * Generate a human-readable session ID like "calm-reef" or "brisk-falcon".
 * Avoids collisions with existing IDs by checking the provided Set.
 * @param {Set<string>} existingIds
 * @returns {string}
 */
export function generateSessionId(existingIds = new Set()) {
  for (let i = 0; i < 100; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const candidate = `${adj}-${noun}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  // Collision fallback: append 4-char hex
  return `${ADJECTIVES[0]}-${NOUNS[0]}-${randomBytes(2).toString('hex')}`;
}
