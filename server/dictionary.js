export async function lookupDefinition(store, rawWord) {
  const word = normalizeWord(rawWord);
  if (!word) {
    return null;
  }

  const cached = store.getCachedDefinition(word);
  if (cached) {
    return cached;
  }

  if (process.env.ONLINE_DICTIONARY === "false") {
    return {
      word,
      source: "offline",
      definitions: [],
      message: "No cached definition is available."
    };
  }

  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    return {
      word,
      source: "dictionaryapi.dev",
      definitions: [],
      message: "No definition found."
    };
  }

  const payload = await response.json();
  const result = normalizeDictionaryPayload(word, payload);
  await store.setCachedDefinition(word, result);
  return result;
}

function normalizeDictionaryPayload(word, payload) {
  const entries = Array.isArray(payload) ? payload : [];
  const definitions = [];

  for (const entry of entries) {
    for (const meaning of entry.meanings || []) {
      for (const definition of meaning.definitions || []) {
        definitions.push({
          partOfSpeech: meaning.partOfSpeech || "",
          definition: definition.definition || "",
          example: definition.example || ""
        });

        if (definitions.length >= 6) {
          break;
        }
      }
      if (definitions.length >= 6) {
        break;
      }
    }
    if (definitions.length >= 6) {
      break;
    }
  }

  return {
    word,
    source: "dictionaryapi.dev",
    phonetic: entries.find((entry) => entry.phonetic)?.phonetic || "",
    definitions
  };
}

function normalizeWord(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/g, "")
    .slice(0, 64);
}
