// An extension that allows you to import characters from CHub.
// TODO: allow multiple characters to be imported at once
import {
    getRequestHeaders,
    processDroppedFiles,
    callPopup
} from "../../../../script.js";
import { delay, debounce } from "../../../utils.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "Work-SillyTavern-Chub-Search";
const extensionFolderPath = `scripts/extensions/${extensionName}/`;

// Endpoint for API call
const API_ENDPOINT_SEARCH = "https://inference.chub.ai/search"; // Use the characters endpoint
// Or use the generic search endpoint if needed: const API_ENDPOINT_SEARCH = "https://api.chub.ai/api/search";
const API_ENDPOINT_DOWNLOAD = "https://api.chub.ai/api/characters/download";

// Character Tavern endpoints (undocumented, reverse-engineered from the site's JS bundles).
// character-tavern.com does not send CORS headers, so browser-side fetches to it are blocked.
// We route requests through SillyTavern's built-in CORS proxy (/proxy/<url>), which requires
// the server to be started with --corsProxy or "enableCorsProxy: true" in config.yaml.
const CT_API_SEARCH = "https://character-tavern.com/api/search/cards";
const CT_API_CHARACTER = "https://character-tavern.com/api/character";
const CT_IMAGE_BASE = "https://ct-cards.storage.character-tavern.com";

// AICharacterCards endpoints (undocumented, reverse-engineered from the site's JS bundles).
// api.aicharactercards.com also sends no CORS headers, so this goes through the same proxy.
// Cards are hosted as ready-made PNGs with metadata already embedded, so importing them
// works exactly like Chub: fetch the file and hand it straight to processDroppedFiles.
const AICC_API_BASE = "https://api.aicharactercards.com/api";
const AICC_FILE_BASE = "https://api.aicharactercards.com";

// CharacterCard.com endpoints (undocumented; the site has no classic REST search API, it's a
// Next.js app that renders search results server-side as React Server Component payloads).
// Requesting the page with an "RSC: 1" header returns that payload as text instead of full
// HTML, and character objects can be pulled out of it with a regex since it's not valid JSON
// on its own. No CORS headers either, so this also goes through the proxy. Cards are hosted
// as ready-made PNGs with metadata already embedded (same as AICharacterCards/Chub); the file
// URL is derived from the cover image URL embedded in the search results.
const CC_SEARCH_PAGE = "https://charactercard.com/download";
const CC_CHARACTER_RE = /"id":"([a-f0-9-]{36})","name":"((?:[^"\\]|\\.)*)","tagline":"((?:[^"\\]|\\.)*)","greeting":"((?:[^"\\]|\\.)*)","seo_description":"((?:[^"\\]|\\.)*)","avatar_image_url":"((?:[^"\\]|\\.)*)"/g;

/**
 * Fetches a URL through SillyTavern's CORS proxy, since character-tavern.com does not
 * allow direct cross-origin requests from the browser.
 * @param {string} url - The absolute URL to fetch.
 * @param {RequestInit} [options] - Standard fetch options.
 * @returns {Promise<Response>}
 */
async function ctFetch(url, options = {}) {
    // The full target URL (including its own query string) must be encoded as a single
    // path segment, otherwise Express splits off anything after "?" as the proxy
    // request's own query string and it never reaches the target URL.
    const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl, options);
    if (response.status === 404) {
        throw new Error('CORS_PROXY_DISABLED');
    }
    return response;
}

const defaultSettings = {
    findCount: 30, // Corresponds to 'first'
    nsfw: false,
    nsfl: false,
    // Adding new defaults for boolean flags
    nsfw_only: false,
    require_images: false,
    require_example_dialogues: false,
    require_alternate_greetings: false,
    require_custom_prompt: false,
    require_expressions: false,
    require_lore: false,
    require_lore_embedded: false,
    require_lore_linked: false,
    inclusive_or: false, // Default behavior is usually AND (false) for tags
    recommended_verified: false,
};

let chubCharacters = [];
let ctCharacters = [];
let aiccCharacters = [];
let ccCharacters = [];
let activeSource = 'chub'; // 'chub', 'ct', 'aicc', or 'cc'
let characterListContainer = null;  // A global variable to hold the reference
let popupState = null;
let savedPopupContent = null;


/**
 * Asynchronously loads settings from `extension_settings.chub`,
 * filling in with default settings if some are missing.
 *
 * After loading the settings, it also updates the UI components
 * with the appropriate values from the loaded settings.
 */
async function loadSettings() {
    // Ensure extension_settings.chub exists
    if (!extension_settings.chub) {
        console.log("Creating extension_settings.chub");
        extension_settings.chub = {};
    }

    // Check and merge each default setting if it doesn't exist
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.chub.hasOwnProperty(key)) {
            console.log(`Setting default for: ${key}`);
            extension_settings.chub[key] = value;
        }
    }
    // Ensure findCount is a number after loading
    extension_settings.chub.findCount = Number(extension_settings.chub.findCount) || defaultSettings.findCount;
}

/**
 * Downloads a custom character based on the provided URL.
 * @param {string} input - A string containing the URL of the character to be downloaded.
 * @returns {Promise<void>} - Resolves once the character has been processed or if an error occurs.
 */
async function downloadCharacter(input) {
    const url = input.trim();
    console.debug('Custom content import started', url);
    let request = null;
    // try /api/content/import first and then /import_custom
    request = await fetch('/api/content/importUUID', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url }),
    });
    if (!request.ok) {
        request = await fetch('/import_custom', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ url }),
        });
    }

    if (!request.ok) {
        toastr.info("Click to go to the character page", 'Custom content import failed', {onclick: () => window.open(`https://www.chub.ai/characters/${url}`, '_blank') });
        console.error('Custom content import failed', request.status, request.statusText);
        return;
    }

    const data = await request.blob();
    const customContentType = request.headers.get('X-Custom-Content-Type');
    const fileName = request.headers.get('Content-Disposition').split('filename=')[1].replace(/"/g, '');
    const file = new File([data], fileName, { type: data.type });

    switch (customContentType) {
        case 'character':
            processDroppedFiles([file]);
            break;
        default:
            toastr.warning('Unknown content type');
            console.error('Unknown content type', customContentType);
            break;
    }
}

/**
 * Computes the CRC32 checksum used by PNG chunks (over the chunk type + data bytes).
 * @param {Uint8Array} bytes - Bytes to checksum.
 * @returns {number} - Unsigned 32-bit CRC.
 */
function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Builds a raw PNG chunk (length + type + data + CRC) as per the PNG spec.
 * @param {string} type - 4-character chunk type (e.g. "tEXt").
 * @param {Uint8Array} data - Chunk payload.
 * @returns {Uint8Array} - The fully encoded chunk, ready to be spliced into a PNG buffer.
 */
function buildPngChunk(type, data) {
    const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length, false);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcInput), false);
    return chunk;
}

/**
 * Embeds a Character Card V2 JSON payload into a PNG image as a "chara" tEXt chunk,
 * the same format SillyTavern itself writes and reads for character card avatars.
 * @param {ArrayBuffer} imageBuffer - Raw PNG file bytes.
 * @param {object} cardV2 - The Character Card V2 object to embed.
 * @returns {Uint8Array} - A new PNG buffer with the metadata chunk inserted before IEND.
 */
function embedCharaIntoPng(imageBuffer, cardV2) {
    const bytes = new Uint8Array(imageBuffer);
    const pngSignature = bytes.slice(0, 8);

    // Walk the chunk list, dropping any pre-existing "chara"/"ccv3" tEXt chunks.
    const chunks = [];
    let offset = 8;
    while (offset < bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
        const length = view.getUint32(0, false);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const chunkEnd = offset + 12 + length;
        const chunkBytes = bytes.slice(offset, chunkEnd);

        if (type === 'tEXt') {
            const data = chunkBytes.slice(8, 8 + length);
            const nullIndex = data.indexOf(0);
            const keyword = nullIndex >= 0 ? String.fromCharCode(...data.slice(0, nullIndex)) : '';
            if (keyword.toLowerCase() === 'chara' || keyword.toLowerCase() === 'ccv3') {
                offset = chunkEnd;
                continue;
            }
        }

        chunks.push(chunkBytes);
        offset = chunkEnd;
    }

    // Build the "chara" tEXt chunk: keyword + \x00 + base64(JSON), as SillyTavern expects.
    const base64Data = btoa(unescape(encodeURIComponent(JSON.stringify(cardV2))));
    const keyword = 'chara';
    const textPayload = new Uint8Array(keyword.length + 1 + base64Data.length);
    for (let i = 0; i < keyword.length; i++) textPayload[i] = keyword.charCodeAt(i);
    textPayload[keyword.length] = 0;
    for (let i = 0; i < base64Data.length; i++) textPayload[keyword.length + 1 + i] = base64Data.charCodeAt(i);
    const charaChunk = buildPngChunk('tEXt', textPayload);

    // Insert the new chunk right before IEND (always the last chunk in a valid PNG).
    const iendIndex = chunks.length - 1;
    chunks.splice(iendIndex, 0, charaChunk);

    const totalLength = pngSignature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    output.set(pngSignature, 0);
    let writeOffset = pngSignature.length;
    for (const chunk of chunks) {
        output.set(chunk, writeOffset);
        writeOffset += chunk.length;
    }
    return output;
}

/**
 * Downloads a character from Character Tavern and imports it into SillyTavern.
 * Character Tavern has no ready-made PNG/download endpoint like Chub, so we fetch
 * the raw card fields via its API, assemble a Character Card V2 JSON payload, and
 * embed it into the card's own preview image so the avatar comes through on import
 * (a plain JSON import would leave SillyTavern's default placeholder avatar instead).
 * @param {string} id - The Character Tavern card id (e.g. "CT_xxxx...").
 * @param {string} path - The "author/char_name" path, used for the API and image lookup.
 * @returns {Promise<void>}
 */
async function downloadCTCharacter(id, path) {
    console.debug('Character Tavern import started', id, path);
    try {
        const [author, charName] = path.split('/');
        const imageUrl = `${CT_IMAGE_BASE}/${path}.png?format=png`;
        const [detailRes, tagsRes, greetingsRes, imageRes] = await Promise.all([
            ctFetch(`${CT_API_CHARACTER}/${encodeURIComponent(author)}/${encodeURIComponent(charName)}`),
            ctFetch(`${CT_API_CHARACTER}/${encodeURIComponent(id)}/tags`),
            ctFetch(`${CT_API_CHARACTER}/${encodeURIComponent(id)}/alternative-greetings`),
            ctFetch(imageUrl),
        ]);

        if (!detailRes.ok) {
            throw new Error(`Character detail request failed: ${detailRes.status}`);
        }

        const { card } = await detailRes.json();
        const tags = tagsRes.ok ? await tagsRes.json() : [];
        const alternateGreetings = greetingsRes.ok ? await greetingsRes.json() : [];

        const cardV2 = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: card.name || charName,
                description: card.definition_character_description || '',
                personality: card.definition_personality || '',
                scenario: card.definition_scenario || '',
                first_mes: card.definition_first_message || '',
                mes_example: card.definition_example_messages || '',
                creator_notes: card.tagline || '',
                system_prompt: card.definition_system_prompt || '',
                post_history_instructions: card.definition_post_history_prompt || '',
                alternate_greetings: Array.isArray(alternateGreetings) ? alternateGreetings : [],
                tags: Array.isArray(tags) ? tags : [],
                creator: author || '',
                character_version: '',
                extensions: {},
            },
        };

        let file;
        if (imageRes.ok) {
            const imageBuffer = await imageRes.arrayBuffer();
            const pngWithMetadata = embedCharaIntoPng(imageBuffer, cardV2);
            const pngBlob = new Blob([pngWithMetadata], { type: 'image/png' });
            file = new File([pngBlob], `${cardV2.data.name}.png`, { type: 'image/png' });
        } else {
            console.warn(`Could not fetch avatar image for ${path} (${imageRes.status}), importing without one.`);
            const jsonBlob = new Blob([JSON.stringify(cardV2)], { type: 'application/json' });
            file = new File([jsonBlob], `${cardV2.data.name}.json`, { type: 'application/json' });
        }

        await processDroppedFiles([file]);
        toastr.success(`Imported "${cardV2.data.name}" from Character Tavern.`);
    } catch (error) {
        console.error('Character Tavern import failed', error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use Character Tavern.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.info("Click to go to the character page", 'Character Tavern import failed', { onclick: () => window.open(`https://character-tavern.com/character/${path}`, '_blank') });
        }
    }
}

/**
 * Downloads a character from AICharacterCards and imports it into SillyTavern.
 * Unlike Character Tavern, AICharacterCards hosts ready-made PNG files with the character
 * card metadata already embedded (like Chub), so we just fetch the file and hand it off.
 * @param {number|string} id - The AICharacterCards card id.
 * @param {string} fallbackName - Card title, used for the toast/filename if the fetch fails oddly.
 * @returns {Promise<void>}
 */
async function downloadAICCCharacter(id, fallbackName) {
    console.debug('AICharacterCards import started', id);
    try {
        const detailRes = await ctFetch(`${AICC_API_BASE}/cards/${encodeURIComponent(id)}`);
        if (!detailRes.ok) {
            throw new Error(`Card detail request failed: ${detailRes.status}`);
        }
        const card = await detailRes.json();
        const currentVersion = Array.isArray(card.versions) ? card.versions.find(v => v.isCurrent) || card.versions[0] : null;
        if (!currentVersion?.fileUrl) {
            throw new Error('Card has no downloadable file');
        }

        const fileUrl = `${AICC_FILE_BASE}${currentVersion.fileUrl}`;
        const fileRes = await ctFetch(fileUrl);
        if (!fileRes.ok) {
            throw new Error(`File download failed: ${fileRes.status}`);
        }

        const blob = await fileRes.blob();
        const fileName = currentVersion.fileName || `${card.title || fallbackName || 'character'}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        await processDroppedFiles([file]);
        toastr.success(`Imported "${card.title || fallbackName}" from AICharacterCards.`);
    } catch (error) {
        console.error('AICharacterCards import failed', error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use AICharacterCards.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.error(`Could not import "${fallbackName}" from AICharacterCards.`, 'Import failed');
        }
    }
}

/**
 * Downloads a character from CharacterCard.com and imports it into SillyTavern.
 * Like AICharacterCards, cards are ready-made PNGs with metadata already embedded.
 * The download file lives at the same path as the cover image, just under "/card/"
 * instead of "/cover/" and with a ".png" extension instead of ".webp".
 * @param {string} coverUrl - The character's cover image URL from the search results.
 * @param {string} fallbackName - Card title, used for the toast/filename if anything is missing.
 * @returns {Promise<void>}
 */
async function downloadCCCharacter(coverUrl, fallbackName) {
    console.debug('CharacterCard.com import started', coverUrl);
    try {
        const fileUrl = coverUrl.replace('/cover/', '/card/').replace(/\.webp$/i, '.png');
        if (fileUrl === coverUrl) {
            throw new Error('Could not derive card file URL from cover image URL');
        }

        const fileRes = await ctFetch(fileUrl);
        if (!fileRes.ok) {
            throw new Error(`File download failed: ${fileRes.status}`);
        }

        const blob = await fileRes.blob();
        const fileName = `${fallbackName || 'character'}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });

        await processDroppedFiles([file]);
        toastr.success(`Imported "${fallbackName}" from CharacterCard.com.`);
    } catch (error) {
        console.error('CharacterCard.com import failed', error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use CharacterCard.com.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.error(`Could not import "${fallbackName}" from CharacterCard.com.`, 'Import failed');
        }
    }
}

/**
 * Updates the character list in the view based on provided characters.
 * @param {Array} characters - A list of character data objects to be rendered in the view.
 * @param {string} source - Which source the characters came from ('chub' or 'ct').
 */
function updateCharacterListInView(characters, source) {
    if (characterListContainer) {
        characterListContainer.innerHTML = characters.map((character, index) => generateCharacterListItem(character, index, source)).join('');
    }
}

// Removed makeTagPermutations as the API likely handles variations.

/**
 * Builds the query string for the API call based on the provided options.
 * @param {object} options - The search options object.
 * @returns {string} - The generated query string part of the URL.
 */
function buildQueryString(options) {
    const params = new URLSearchParams();

    // Map simplified option names to API parameter names
    const paramMap = {
        searchTerm: 'search', // Full-text search
        name_like: 'name_like',
        first: 'first',
        min_users_chatted: 'min_users_chatted',
        includeTags: 'tags',
        excludeTags: 'exclude_tags',
        page: 'page',
        sort: 'sort',
        asc: 'asc',
        include_forks: 'include_forks',
        nsfw: 'nsfw',
        nsfl: 'nsfl',
        nsfw_only: 'nsfw_only',
        require_images: 'require_images',
        require_example_dialogues: 'require_example_dialogues',
        require_alternate_greetings: 'require_alternate_greetings',
        require_custom_prompt: 'require_custom_prompt',
        max_days_ago: 'max_days_ago',
        exclude_mine: 'exclude_mine', // Might require auth context
        only_mine: 'only_mine', // Might require auth context
        min_tokens: 'min_tokens',
        max_tokens: 'max_tokens',
        require_expressions: 'require_expressions',
        require_lore: 'require_lore',
        mine_first: 'mine_first', // Might require auth context
        require_lore_embedded: 'require_lore_embedded',
        require_lore_linked: 'require_lore_linked',
        my_favorites: 'my_favorites', // Might require auth context
        topics: 'topics', // Alternative tag system?
        excludetopics: 'excludetopics', // Alternative tag system?
        creator_id: 'creator_id',
        username: 'username',
        inclusive_or: 'inclusive_or',
        recommended_verified: 'recommended_verified',
        min_tags: 'min_tags',
        min_ai_rating: 'min_ai_rating',
        language: 'language',
        // Skip 'count', 'previous', 'special_mode', 'namespace' for now unless specifically needed
    };

    for (const [optionKey, value] of Object.entries(options)) {
        const apiKey = paramMap[optionKey];
        if (apiKey && (value !== null && value !== undefined && value !== '')) {
            // Special handling for tags/topics to join array and limit length
            if ((apiKey === 'tags' || apiKey === 'exclude_tags' || apiKey === 'topics' || apiKey === 'excludetopics') && Array.isArray(value)) {
                 if (value.length > 0) {
                     // Join non-empty tags and limit length (adjust limit as needed)
                     const tagsString = value.filter(tag => tag.length > 0).join(',').slice(0, 500);
                     if (tagsString) {
                         params.append(apiKey, tagsString);
                     }
                 }
            }
            // Handle number inputs that might be empty strings
            else if (['min_tokens', 'max_tokens', 'min_tags', 'min_users_chatted', 'max_days_ago', 'creator_id', 'min_ai_rating'].includes(apiKey)) {
                const numValue = parseInt(value, 10);
                if (!isNaN(numValue)) {
                     params.append(apiKey, numValue);
                }
            }
             // Handle boolean explicitly to ensure 'false' is sent
             else if (typeof value === 'boolean') {
                 params.append(apiKey, value);
             }
            // Default handling for other types (strings, numbers derived elsewhere like page/first)
            else {
                params.append(apiKey, value);
            }
        }
    }

    // Add venus=true if using the character endpoint? Check API docs. Assume yes for now.
    // params.append('venus', 'true'); // Might not be needed for /api/characters/search

    return params.toString();
}


/**
 * Fetches characters based on specified search criteria.
 * @param {Object} options - The search options object (using internal names like searchTerm, includeTags, etc.).
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function fetchCharactersBySearch(options) {

    // Set defaults from settings if not provided in options
    options.first = options.first || extension_settings.chub.findCount || 30;
    options.nsfw = typeof options.nsfw === 'boolean' ? options.nsfw : extension_settings.chub.nsfw;
    options.nsfl = typeof options.nsfl === 'boolean' ? options.nsfl : extension_settings.chub.nsfl;
    // Add other boolean defaults from settings
    options.nsfw_only = typeof options.nsfw_only === 'boolean' ? options.nsfw_only : extension_settings.chub.nsfw_only;
    options.require_images = typeof options.require_images === 'boolean' ? options.require_images : extension_settings.chub.require_images;
    options.require_example_dialogues = typeof options.require_example_dialogues === 'boolean' ? options.require_example_dialogues : extension_settings.chub.require_example_dialogues;
    options.require_alternate_greetings = typeof options.require_alternate_greetings === 'boolean' ? options.require_alternate_greetings : extension_settings.chub.require_alternate_greetings;
    options.require_custom_prompt = typeof options.require_custom_prompt === 'boolean' ? options.require_custom_prompt : extension_settings.chub.require_custom_prompt;
    options.require_expressions = typeof options.require_expressions === 'boolean' ? options.require_expressions : extension_settings.chub.require_expressions;
    options.require_lore = typeof options.require_lore === 'boolean' ? options.require_lore : extension_settings.chub.require_lore;
    options.require_lore_embedded = typeof options.require_lore_embedded === 'boolean' ? options.require_lore_embedded : extension_settings.chub.require_lore_embedded;
    options.require_lore_linked = typeof options.require_lore_linked === 'boolean' ? options.require_lore_linked : extension_settings.chub.require_lore_linked;
    options.inclusive_or = typeof options.inclusive_or === 'boolean' ? options.inclusive_or : extension_settings.chub.inclusive_or;
    options.recommended_verified = typeof options.recommended_verified === 'boolean' ? options.recommended_verified : extension_settings.chub.recommended_verified;

    // Sensible defaults for non-setting options if not provided
    options.sort = options.sort || 'download_count';
    options.page = options.page || 1;
    options.asc = typeof options.asc === 'boolean' ? options.asc : false; // Default sort descending
    options.include_forks = typeof options.include_forks === 'boolean' ? options.include_forks : true; // Default include forks


    // Construct the URL with the search parameters
    const queryString = buildQueryString(options);
    const url = `${API_ENDPOINT_SEARCH}?${queryString}`;
    console.log("Fetching CHub:", url); // Log the final URL for debugging

    try {
        const searchResponse = await fetch(url);

        if (!searchResponse.ok) {
            console.error('CHub API request failed:', searchResponse.status, searchResponse.statusText);
            try {
                const errorData = await searchResponse.json();
                console.error('API Error Details:', errorData);
                toastr.error(`CHub search failed: ${errorData.message || searchResponse.statusText}`, "API Error");
            } catch (e) {
                toastr.error(`CHub search failed: ${searchResponse.statusText}`, "API Error");
            }
            return []; // Return empty array on failure
        }

        const searchData = await searchResponse.json();

        // Clear previous search results
        chubCharacters = [];

        // The API structure might be { data: { nodes: [...] } } or just { nodes: [...] }
        // Adapt based on actual API response. Assuming /api/characters/search returns { nodes: [...] }
        const nodes = searchData.nodes || (searchData.data ? searchData.data.nodes : null);

        if (!nodes || nodes.length === 0) {
            return chubCharacters; // Return empty if no nodes found
        }

        // Fetching individual character *avatars* seems inefficient here.
        // The search result 'nodes' should contain basic info including avatar URL.
        // Let's adapt to use the info directly from the search result.
        // Check the actual API response structure for avatar URLs. Common names: 'avatar_url', 'avatar', 'image_url'

        chubCharacters = nodes.map(node => {
            // Determine the avatar URL - *adjust based on actual API response field names*
            // Common possibilities: node.avatar_url, node.avatar, node.definition.avatar etc.
            // Using a placeholder - **YOU MUST CHECK THE ACTUAL API RESPONSE**
            let imageUrl = node.avatar_url || node.avatar || `${extensionFolderPath}placeholder.png`; // Provide a fallback placeholder
             // Ensure the URL is absolute if it's relative
             if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('blob:')) {
                 // Assuming it might be relative to chub.ai if not absolute
                 // imageUrl = `https://chub.ai${imageUrl}`; // Uncomment or adjust if needed
             }


            return {
                // Use the image URL directly from search results if available
                url: imageUrl,
                description: node.tagline || "No description.",
                name: node.name || "Unnamed Character",
                fullPath: node.fullPath, // Essential for download links
                tags: node.topics || [], // Assuming 'topics' holds the tags
                author: node.fullPath ? node.fullPath.split('/')[0] : "Unknown Author", // Extract author from fullPath
            };
        });

        return chubCharacters;

    } catch (error) {
        console.error("Error during CHub search fetch:", error);
        toastr.error("An error occurred while searching CHub.", "Fetch Error");
        return []; // Return empty array on exception
    }
}

/**
 * Fetches characters from Character Tavern based on specified search criteria.
 * @param {Object} options - Search options: searchTerm, includeTags, excludeTags, min_tokens, max_tokens,
 *                            require_lore (hasLorebook), require_oc (isOC), sort, page, first.
 * @returns {Promise<Array>} - Resolves with an array of normalized character objects.
 */
async function fetchCTCharactersBySearch(options) {
    const params = new URLSearchParams();

    if (options.searchTerm) params.set('query', options.searchTerm);
    params.set('sort', options.sort || 'most_popular');
    params.set('page', String(options.page || 1));
    params.set('limit', String(options.first || extension_settings.chub.findCount || 30));
    if (Array.isArray(options.includeTags) && options.includeTags.length > 0) {
        params.set('tags', options.includeTags.join(','));
    }
    if (Array.isArray(options.excludeTags) && options.excludeTags.length > 0) {
        params.set('exclude_tags', options.excludeTags.join(','));
    }
    if (options.min_tokens) params.set('minimum_tokens', String(options.min_tokens));
    if (options.max_tokens) params.set('maximum_tokens', String(options.max_tokens));
    if (options.require_lore) params.set('hasLorebook', 'true');
    if (options.require_oc) params.set('isOC', 'true');

    const url = `${CT_API_SEARCH}?${params.toString()}`;
    console.log("Fetching Character Tavern:", url);

    try {
        const searchResponse = await ctFetch(url, { headers: { 'Accept': 'application/json' } });

        if (!searchResponse.ok) {
            console.error('Character Tavern API request failed:', searchResponse.status, searchResponse.statusText);
            toastr.error(`Character Tavern search failed: ${searchResponse.statusText}`, "API Error");
            return [];
        }

        const searchData = await searchResponse.json();
        const hits = searchData.hits || [];

        ctCharacters = hits.map(hit => ({
            url: `${CT_IMAGE_BASE}/${hit.path}.png?width=256&quality=80&format=auto`,
            description: hit.tagline || "No description.",
            name: hit.name || "Unnamed Character",
            fullPath: hit.path,
            id: hit.id,
            tags: [], // Not included in search results; fetched on demand only when importing
            author: hit.author || "Unknown Author",
            downloads: hit.downloads,
            likes: hit.likes,
        }));

        return ctCharacters;

    } catch (error) {
        console.error("Error during Character Tavern search fetch:", error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use Character Tavern.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.error("An error occurred while searching Character Tavern.", "Fetch Error");
        }
        return [];
    }
}

/**
 * Fetches characters from AICharacterCards based on specified search criteria.
 * Text/tag/NSFW search goes through the generic listing endpoint; the "curated" sort
 * options (most downloaded, top AI-rated, trending) have their own dedicated endpoints
 * that ignore search/tag filters, matching how the site's own UI behaves.
 * @param {Object} options - Search options: searchTerm, includeTags, page, first, sort, nsfwFilter.
 * @returns {Promise<Array>} - Resolves with an array of normalized character objects.
 */
async function fetchAICCCharactersBySearch(options) {
    const limit = options.first || extension_settings.chub.findCount || 30;
    const page = options.page || 1;
    const curatedEndpoints = {
        most_downloaded: 'cards/most-downloaded',
        top_ai_rated: 'cards/top-ai-rated',
        trending: 'cards/trending',
    };

    const params = new URLSearchParams();
    let endpoint;

    if (curatedEndpoints[options.sort]) {
        endpoint = curatedEndpoints[options.sort];
        params.set('limit', String(limit));
        if (options.nsfwFilter) params.set('nsfw', options.nsfwFilter);
    } else {
        endpoint = 'cards';
        params.set('page', String(page));
        params.set('limit', String(limit));
        if (options.searchTerm) params.set('search', options.searchTerm);
        if (Array.isArray(options.includeTags) && options.includeTags.length > 0) {
            params.set('tags', options.includeTags.join(','));
        }
        if (options.nsfwFilter === 'sfw') params.set('isNsfw', 'false');
        if (options.nsfwFilter === 'nsfw') params.set('isNsfw', 'true');
    }

    const url = `${AICC_API_BASE}/${endpoint}?${params.toString()}`;
    console.log("Fetching AICharacterCards:", url);

    try {
        const searchResponse = await ctFetch(url, { headers: { 'Accept': 'application/json' } });

        if (!searchResponse.ok) {
            console.error('AICharacterCards API request failed:', searchResponse.status, searchResponse.statusText);
            toastr.error(`AICharacterCards search failed: ${searchResponse.statusText}`, "API Error");
            return [];
        }

        const searchData = await searchResponse.json();
        const cards = searchData.data || [];

        aiccCharacters = cards.map(card => {
            let imageUrl = card.imageUrl ? `${AICC_FILE_BASE}${card.imageUrl}` : `${extensionFolderPath}placeholder.png`;
            if (card.isAnimated && card.imageUrl) {
                imageUrl = `${AICC_FILE_BASE}${card.imageUrl.replace(/-opt\.webp$/i, '.png')}`;
            }
            return {
                url: imageUrl,
                description: card.excerpt || card.description || "No description.",
                name: card.title || "Unnamed Character",
                id: card.id,
                tags: Array.isArray(card.tags) ? card.tags.map(t => t.name || t) : [],
                author: card.author || "Unknown Author",
                downloads: card.downloadCount,
                aiScore: card.aiScore,
            };
        });

        return aiccCharacters;

    } catch (error) {
        console.error("Error during AICharacterCards search fetch:", error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use AICharacterCards.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.error("An error occurred while searching AICharacterCards.", "Fetch Error");
        }
        return [];
    }
}

/**
 * Fetches characters from CharacterCard.com based on specified search criteria.
 * There's no classic REST search API here; the site's Next.js app renders results
 * server-side. Requesting the page with the "RSC: 1" header returns the React Server
 * Component payload as text instead of full HTML, and character objects are pulled out
 * of it with a regex (see CC_CHARACTER_RE) since the payload isn't valid JSON on its own.
 * No working pagination parameter was found, so this always returns the first result set.
 * @param {Object} options - Search options: searchTerm, includeTags.
 * @returns {Promise<Array>} - Resolves with an array of normalized character objects.
 */
async function fetchCCCharactersBySearch(options) {
    const params = new URLSearchParams();
    if (options.searchTerm) params.set('search', options.searchTerm);
    if (Array.isArray(options.includeTags) && options.includeTags.length > 0) {
        params.set('tags', options.includeTags.join(','));
    }

    const url = `${CC_SEARCH_PAGE}?${params.toString()}`;
    console.log("Fetching CharacterCard.com:", url);

    try {
        const searchResponse = await ctFetch(url, { headers: { 'RSC': '1' } });

        if (!searchResponse.ok) {
            console.error('CharacterCard.com request failed:', searchResponse.status, searchResponse.statusText);
            toastr.error(`CharacterCard.com search failed: ${searchResponse.statusText}`, "API Error");
            return [];
        }

        const payload = await searchResponse.text();
        const results = [];
        let match;
        CC_CHARACTER_RE.lastIndex = 0;
        while ((match = CC_CHARACTER_RE.exec(payload)) !== null) {
            const [, id, name, tagline, , , avatarUrl] = match;
            const unescapeJsonString = (s) => s.replace(/\\(.)/g, '$1');

            // Tags aren't part of the fixed field order matched above, so grab the next
            // "tags":[...] array that appears before the following character object starts.
            const afterMatch = match.index + match[0].length;
            const nextCharIndex = payload.indexOf('"id":"', afterMatch);
            const window = payload.slice(afterMatch, nextCharIndex === -1 ? afterMatch + 1000 : nextCharIndex);
            const tagsMatch = window.match(/"tags":\[(.*?)\]/);
            const tags = tagsMatch
                ? tagsMatch[1].split(',').map(t => unescapeJsonString(t.trim().replace(/^"|"$/g, ''))).filter(Boolean)
                : [];

            results.push({
                url: unescapeJsonString(avatarUrl),
                description: unescapeJsonString(tagline) || "No description.",
                name: unescapeJsonString(name) || "Unnamed Character",
                id,
                tags,
                author: "Unknown Author", // Not present in the search result payload.
            });
        }

        ccCharacters = results;
        return ccCharacters;

    } catch (error) {
        console.error("Error during CharacterCard.com search fetch:", error);
        if (error?.message === 'CORS_PROXY_DISABLED') {
            toastr.error('Enable "enableCorsProxy" in config.yaml (or start with --corsProxy) to use CharacterCard.com.', 'CORS proxy disabled', { timeOut: 8000 });
        } else {
            toastr.error("An error occurred while searching CharacterCard.com.", "Fetch Error");
        }
        return [];
    }
}


/**
 * Searches for characters based on the provided options and manages the UI during the search.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function searchCharacters(options, source) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        console.log('Character list container is not in the DOM, removing reference');
        characterListContainer = null;
    }
    // grey out the character-list-popup while we're searching
    if (characterListContainer) {
        characterListContainer.classList.add('searching');
    }
    console.log('Searching for characters with options:', options);
    const fetchers = {
        ct: fetchCTCharactersBySearch,
        aicc: fetchAICCCharactersBySearch,
        cc: fetchCCCharactersBySearch,
    };
    const characters = await (fetchers[source] || fetchCharactersBySearch)(options);
    if (characterListContainer) {
        characterListContainer.classList.remove('searching');
    }

    return characters;
}

/**
 * Opens the character search popup UI.
 */
function openSearchPopup() {
    displayCharactersInListViewPopup();
}

/**
 * Executes a character search based on provided options and updates the view with the results.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @param {string} source - Which source to search ('chub' or 'ct').
 * @returns {Promise<void>} - Resolves once the character list has been updated in the view.
 */
async function executeCharacterSearch(options, source) {
    // Clear the previous search result first
    updateCharacterListInView([], source);  // Resetting character list before fetching new characters

    let characters = await searchCharacters(options, source);

    // Bail out if the user switched tabs while this search was in flight
    if (source !== activeSource) {
        return;
    }

    if (characters && characters.length > 0) {
        console.log(`Found ${characters.length} characters. Updating character list.`);
        updateCharacterListInView(characters, source);
    } else {
        console.log('No characters found');
        if (characterListContainer) { // Ensure container exists before modifying
             characterListContainer.innerHTML = '<div class="chub-no-characters-found">No characters found for the specified criteria.</div>';
        }
    }
}


/**
 * Generates the HTML structure for a character list item.
 * @param {Object} character - The character data object with properties like url, name, description, tags, and author.
 * @param {number} index - The index of the character in the list.
 * @param {string} source - Which source this character came from ('chub' or 'ct'), used for links and the download button.
 * @returns {string} - Returns an HTML string representation of the character list item.
 */
function generateCharacterListItem(character, index, source = 'chub') {
    // Use a placeholder if the image URL is invalid or missing
    const imageUrl = character.url && character.url !== `${extensionFolderPath}placeholder.png` ? character.url : `${extensionFolderPath}placeholder.png`;
    const placeholderImg = `${extensionFolderPath}placeholder.png`; // Define placeholder path

    const sourceMeta = {
        chub: {
            label: 'Chub.ai',
            characterPageUrl: `https://chub.ai/characters/${character.fullPath}`,
            authorPageUrl: `https://chub.ai/users/${character.author}`,
            downloadAttrs: `data-source="chub" data-path="${character.fullPath}"`,
        },
        ct: {
            label: 'Character Tavern',
            characterPageUrl: `https://character-tavern.com/character/${character.fullPath}`,
            authorPageUrl: `https://character-tavern.com/creator/${character.author}`,
            downloadAttrs: `data-source="ct" data-id="${character.id}" data-path="${character.fullPath}"`,
        },
        aicc: {
            label: 'AICharacterCards',
            characterPageUrl: `https://aicharactercards.com/cards/${character.id}`,
            authorPageUrl: null, // No known author profile URL scheme; shown as plain text instead.
            downloadAttrs: `data-source="aicc" data-id="${character.id}" data-name="${character.name}"`,
        },
        cc: {
            label: 'CharacterCard.com',
            characterPageUrl: `https://charactercard.com/character/${character.id}/profile`,
            authorPageUrl: null, // Not present in the search result payload.
            downloadAttrs: `data-source="cc" data-cover-url="${character.url}" data-name="${character.name}"`,
        },
    };
    const { label: siteLabel, characterPageUrl, authorPageUrl, downloadAttrs } = sourceMeta[source] || sourceMeta.chub;

    const authorHtml = character.author === "Unknown Author"
        ? ''
        : authorPageUrl
            ? `<a href="${authorPageUrl}" target="_blank" title="View author on ${siteLabel}: ${character.author}"><span class="chub-author">by ${character.author}</span></a>`
            : `<span class="chub-author">by ${character.author}</span>`;

    return `
        <div class="chub-character-item" data-index="${index}">
            <img class="chub-thumbnail" src="${imageUrl}" onerror="this.onerror=null; this.src='${placeholderImg}';">
            <div class="chub-info">
                <a href="${characterPageUrl}" target="_blank" title="View on ${siteLabel}: ${character.name}"><div class="chub-name">${character.name || "Default Name"}</div></a>
                ${authorHtml}
                <div class="chub-description">${character.description}</div>
                <div class="chub-tags">${character.tags.slice(0, 8).map(tag => `<span class="chub-tag">${tag}</span>`).join('')}</div>
            </div>
            <div ${downloadAttrs} class="menu_button fa-solid fa-cloud-arrow-down faSmallFontSquareFix chub-download-btn" title="Import Character"></div>
        </div>
    `;
}

// good ol' clamping
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Creates the HTML layout string for the search popup.
 * @returns {string} - The HTML string for the popup content.
 */
function createPopupLayout() {
     const readableSortOptions = {
        "download_count": "Downloads",
        "last_activity_at": "Last Activity",
        "rating": "Rating",
        "created_at": "Creation Date",
        "name": "Name",
        "n_tokens": "Tokens",
        "trending_downloads": "Trending",
        "id": "ID (Newest)", // Assuming higher ID is newer
        "rating_count": "Rating Count",
        "random": "Random"
        // Add other relevant sort options from API docs if needed
    };

    // Load current settings to pre-fill checkboxes etc. Use defaults if settings not loaded yet.
    const currentSettings = extension_settings.chub || defaultSettings;

    // Helper to create checkbox HTML
    const createCheckbox = (id, label, checked = false, title = '') => `
        <div class="flex-container flex-no-wrap flex-align-center chub-filter-item">
            <label for="${id}" title="${title}">${label}:</label>
            <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
        </div>`;

    // Helper to create number input HTML
    const createNumberInput = (id, label, placeholder = '', value = '', min = null, title = '') => `
        <div class="flex-container flex-no-wrap flex-align-center chub-filter-item">
            <label for="${id}" title="${title}">${label}:</label>
            <input type="number" id="${id}" class="text_pole textarea_compact wide100pMinFit" placeholder="${placeholder}" value="${value}" ${min !== null ? `min="${min}"` : ''}>
        </div>`;

     // Helper to create text input HTML (label rendered above the input to save horizontal space)
     const createTextInput = (id, label, placeholder = '', value = '', title = '', extra = '') => `
         <div class="chub-search-field">
             <label for="${id}" title="${title}">${label}${extra}</label>
             <input type="text" id="${id}" class="text_pole" placeholder="${placeholder}" value="${value}">
         </div>`;

    const ctReadableSortOptions = {
        "most_popular": "Most Popular",
        "trending": "Trending",
        "newest": "Newest",
        "oldest": "Oldest",
        "most_liked": "Most Liked",
        "most_chatted": "Most Chatted",
    };

    const aiccReadableSortOptions = {
        "": "Newest",
        "most_downloaded": "Most Downloaded",
        "top_ai_rated": "Top AI-Rated",
        "trending": "Trending",
    };

    const chubTab = activeSource === 'chub';
    const ctTab = activeSource === 'ct';
    const aiccTab = activeSource === 'aicc';
    const ccTab = activeSource === 'cc';
    const charactersBySource = { chub: chubCharacters, ct: ctCharacters, aicc: aiccCharacters, cc: ccCharacters };
    const activeCharacters = charactersBySource[activeSource] || [];

    return `
<div class="chub-wrapper" id="list-and-search-wrapper">
    <div class="chub-source-tabs">
        <div class="chub-source-tab${chubTab ? ' active' : ''}" data-source-tab="chub">Chub</div>
        <div class="chub-source-tab${ctTab ? ' active' : ''}" data-source-tab="ct">Character Tavern</div>
        <div class="chub-source-tab${aiccTab ? ' active' : ''}" data-source-tab="aicc">AICharacterCards</div>
        <div class="chub-source-tab${ccTab ? ' active' : ''}" data-source-tab="cc">CharacterCard.com</div>
    </div>
    <div class="chub-list-popup">
        ${activeCharacters.map((character, index) => generateCharacterListItem(character, index, activeSource)).join('')}
        <!-- Placeholder message when list is empty -->
        ${activeCharacters.length === 0 ? '<div class="chub-no-characters-found">Perform a search to see characters.</div>' : ''}
    </div>
    <hr class="chub-hr">

    <div class="chub-source-panel" data-source-panel="chub"${chubTab ? '' : ' hidden'}>
    <div class="search-container chub-search-container">
        <div class="chub-search-grid">
            ${createTextInput('characterSearchInput', '<i class="fas fa-search"></i> Full-text search', 'Search name, description, tags...', '', 'Search name, description, tags etc.')}
            ${createTextInput('nameLikeInput', '<i class="fas fa-user"></i> Name contains', 'e.g. Aria', '', 'Search only character names')}
            ${createTextInput('includeTags', '<i class="fas fa-plus-square"></i> Include tags', 'comma separated', '', 'Tags the character MUST have',
                `<span class="chub-inline-checkbox"><input type="checkbox" id="inclusiveOrCheckbox" ${currentSettings.inclusive_or ? 'checked' : ''}><label for="inclusiveOrCheckbox" title="If checked, match ANY included tag (OR). If unchecked, match ALL (AND).">OR</label></span>`)}
            ${createTextInput('excludeTags', '<i class="fas fa-minus-square"></i> Exclude tags', 'comma separated', '', 'Tags the character must NOT have')}
        </div>

        <details class="chub-details">
            <summary class="chub-summary">Filters & Requirements</summary>
            <div class="chub-filter-grid">
                ${createNumberInput('minTokensInput', 'Min Tokens', 'e.g., 100', '', 0, 'Minimum character definition tokens')}
                ${createNumberInput('maxTokensInput', 'Max Tokens', 'e.g., 4000', '', 0, 'Maximum character definition tokens')}
                ${createNumberInput('minTagsInput', 'Min Tags', 'e.g., 3', '', 0, 'Minimum number of tags')}
                ${createNumberInput('minUsersChattedInput', 'Min Chats', 'e.g., 10', '', 0, 'Minimum users chatted count')}
                ${createNumberInput('maxDaysAgoInput', 'Max Days Ago', 'e.g., 30', '', 0, 'Maximum age of character (in days)')}
                 ${createNumberInput('minAiRatingInput', 'Min AI Rating', 'e.g., 70', '', 0, 'Minimum AI Content Rating (0-100)')}

                ${createCheckbox('nsfwCheckbox', 'NSFW', currentSettings.nsfw, 'Include Not Safe For Work content')}
                ${createCheckbox('nsflCheckbox', 'NSFL', currentSettings.nsfl, 'Include Not Safe For Life content (Gore, etc.)')}
                ${createCheckbox('nsfwOnlyCheckbox', 'NSFW Only', currentSettings.nsfw_only, 'ONLY include NSFW content')}
                ${createCheckbox('requireImagesCheckbox', 'Need Images', currentSettings.require_images, 'Require characters to have gallery images')}
                ${createCheckbox('requireExampleDialoguesCheckbox', 'Need Examples', currentSettings.require_example_dialogues, 'Require characters to have example dialogues')}
                ${createCheckbox('requireAltGreetingsCheckbox', 'Need Greetings', currentSettings.require_alternate_greetings, 'Require characters to have alternate greetings')}
                ${createCheckbox('requireCustomPromptCheckbox', 'Need Prompt', currentSettings.require_custom_prompt, 'Require characters to have a custom main/NSFW prompt')}
                ${createCheckbox('requireExpressionsCheckbox', 'Need Expressions', currentSettings.require_expressions, 'Require characters to have an expression pack')}
                ${createCheckbox('requireLoreCheckbox', 'Need Lore', currentSettings.require_lore, 'Require characters to have any lorebook (linked or embedded)')}
                ${createCheckbox('requireLoreEmbeddedCheckbox', 'Need Emb. Lore', currentSettings.require_lore_embedded, 'Require characters to have an embedded lorebook')}
                ${createCheckbox('requireLoreLinkedCheckbox', 'Need Link. Lore', currentSettings.require_lore_linked, 'Require characters to have a linked lorebook')}
                ${createCheckbox('recommendedVerifiedCheckbox', 'Rec. & Verified', currentSettings.recommended_verified, 'Only show Recommended or Verified characters')}
                ${createCheckbox('includeForksCheckbox', 'Include Forks', true, 'Include forked versions of characters (uncheck for originals only)')}
                 ${createTextInput('languageInput', 'Language', 'e.g., en, ja', '', 'Filter by language code (ISO 639-1)')}
                </div>
        </details>

        <div class="chub-toolbar">
            <div class="chub-toolbar-section chub-sort-controls">
                <label for="sortOrder">Sort:</label>
                <select class="margin0" id="sortOrder">
                    ${Object.entries(readableSortOptions).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}
                </select>
                <label for="sortAscCheckbox" title="Sort ascending instead of descending"><input type="checkbox" id="sortAscCheckbox"> Asc</label>
                <label for="resultsPerPage">Per Page:</label>
                <input type="number" id="resultsPerPage" class="text_pole textarea_compact" min="1" max="100" value="${currentSettings.findCount || 30}">
            </div>
            <div class="chub-toolbar-section page-buttons">
                <button class="menu_button" id="pageDownButton" title="Previous Page"><i class="fas fa-chevron-left"></i></button>
                <label for="pageNumber">Page:</label>
                <input type="number" id="pageNumber" class="text_pole textarea_compact" min="1" value="1">
                <button class="menu_button" id="pageUpButton" title="Next Page"><i class="fas fa-chevron-right"></i></button>
            </div>
            <div class="chub-toolbar-section chub-toolbar-search">
                <div class="menu_button chub-search-button" id="characterSearchButton"><i class="fas fa-search"></i> Search</div>
            </div>
        </div>
    </div>
    </div>

    <div class="chub-source-panel" data-source-panel="ct"${ctTab ? '' : ' hidden'}>
    <div class="search-container chub-search-container">
        <div class="chub-search-grid">
            ${createTextInput('ctSearchInput', '<i class="fas fa-search"></i> Search', 'Search name, tagline...', '', 'Full-text search across name and tagline')}
            ${createTextInput('ctIncludeTags', '<i class="fas fa-plus-square"></i> Include tags', 'comma separated', '', 'Tags the character MUST have')}
            ${createTextInput('ctExcludeTags', '<i class="fas fa-minus-square"></i> Exclude tags', 'comma separated', '', 'Tags the character must NOT have')}
        </div>

        <details class="chub-details">
            <summary class="chub-summary">Filters & Requirements</summary>
            <div class="chub-filter-grid">
                ${createNumberInput('ctMinTokensInput', 'Min Tokens', 'e.g., 100', '', 0, 'Minimum character definition tokens')}
                ${createNumberInput('ctMaxTokensInput', 'Max Tokens', 'e.g., 4000', '', 0, 'Maximum character definition tokens')}
                ${createCheckbox('ctRequireLoreCheckbox', 'Need Lorebook', false, 'Require characters to have a lorebook')}
                ${createCheckbox('ctRequireOcCheckbox', 'Original Character', false, 'Only show characters marked as original characters (OC)')}
            </div>
        </details>

        <div class="chub-toolbar">
            <div class="chub-toolbar-section chub-sort-controls">
                <label for="ctSortOrder">Sort:</label>
                <select class="margin0" id="ctSortOrder">
                    ${Object.entries(ctReadableSortOptions).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}
                </select>
                <label for="ctResultsPerPage">Per Page:</label>
                <input type="number" id="ctResultsPerPage" class="text_pole textarea_compact" min="1" max="100" value="${currentSettings.findCount || 30}">
            </div>
            <div class="chub-toolbar-section page-buttons">
                <button class="menu_button" id="ctPageDownButton" title="Previous Page"><i class="fas fa-chevron-left"></i></button>
                <label for="ctPageNumber">Page:</label>
                <input type="number" id="ctPageNumber" class="text_pole textarea_compact" min="1" value="1">
                <button class="menu_button" id="ctPageUpButton" title="Next Page"><i class="fas fa-chevron-right"></i></button>
            </div>
            <div class="chub-toolbar-section chub-toolbar-search">
                <div class="menu_button chub-search-button" id="ctSearchButton"><i class="fas fa-search"></i> Search</div>
            </div>
        </div>
    </div>
    </div>

    <div class="chub-source-panel" data-source-panel="aicc"${aiccTab ? '' : ' hidden'}>
    <div class="search-container chub-search-container">
        <div class="chub-search-grid">
            ${createTextInput('aiccSearchInput', '<i class="fas fa-search"></i> Search', 'Search title, description...', '', 'Full-text search across title and description')}
            ${createTextInput('aiccIncludeTags', '<i class="fas fa-plus-square"></i> Include tags', 'comma separated', '', 'Tags the character MUST have')}
        </div>

        <details class="chub-details">
            <summary class="chub-summary">Filters</summary>
            <div class="chub-filter-grid">
                <div class="flex-container flex-no-wrap flex-align-center chub-filter-item">
                    <label for="aiccNsfwFilter">NSFW:</label>
                    <select class="margin0" id="aiccNsfwFilter">
                        <option value="">Show All</option>
                        <option value="sfw">SFW Only</option>
                        <option value="nsfw">NSFW Only</option>
                    </select>
                </div>
            </div>
        </details>

        <div class="chub-toolbar">
            <div class="chub-toolbar-section chub-sort-controls">
                <label for="aiccSortOrder">Sort:</label>
                <select class="margin0" id="aiccSortOrder">
                    ${Object.entries(aiccReadableSortOptions).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}
                </select>
                <label for="aiccResultsPerPage">Per Page:</label>
                <input type="number" id="aiccResultsPerPage" class="text_pole textarea_compact" min="1" max="100" value="${currentSettings.findCount || 30}">
            </div>
            <div class="chub-toolbar-section page-buttons">
                <button class="menu_button" id="aiccPageDownButton" title="Previous Page"><i class="fas fa-chevron-left"></i></button>
                <label for="aiccPageNumber">Page:</label>
                <input type="number" id="aiccPageNumber" class="text_pole textarea_compact" min="1" value="1">
                <button class="menu_button" id="aiccPageUpButton" title="Next Page"><i class="fas fa-chevron-right"></i></button>
            </div>
            <div class="chub-toolbar-section chub-toolbar-search">
                <div class="menu_button chub-search-button" id="aiccSearchButton"><i class="fas fa-search"></i> Search</div>
            </div>
        </div>
    </div>
    </div>

    <div class="chub-source-panel" data-source-panel="cc"${ccTab ? '' : ' hidden'}>
    <div class="search-container chub-search-container">
        <div class="chub-search-grid">
            ${createTextInput('ccSearchInput', '<i class="fas fa-search"></i> Search', 'Search name, tagline...', '', 'Full-text search across name and tagline')}
            ${createTextInput('ccIncludeTags', '<i class="fas fa-plus-square"></i> Include tags', 'comma separated', '', 'Tags the character MUST have')}
        </div>

        <div class="chub-toolbar">
            <div class="chub-toolbar-section chub-toolbar-search" style="flex: 1 1 auto; justify-content: flex-end;">
                <div class="menu_button chub-search-button" id="ccSearchButton"><i class="fas fa-search"></i> Search</div>
            </div>
        </div>
    </div>
    </div>
</div>
`;
}


/**
 * Displays a popup for character listings based on certain criteria.
 * Handles popup creation, event listeners for search, pagination, image zoom, and download.
 *
 * @async
 * @function
 * @returns {Promise<void>} - Resolves when the popup is displayed and fully initialized.
 */
async function displayCharactersInListViewPopup() {
    // Regenerate layout each time to reflect potential setting changes
    // If performance becomes an issue, optimize later, but this ensures freshness.
    savedPopupContent = null; // Force regeneration
    const listLayout = createPopupLayout();

    // Call the popup with our list layout
    // Use a unique ID for the popup content if needed elsewhere
    callPopup(listLayout, "text", '', { okButton: "Close", wide: true, large: true, popupId: "chub-search-popup" })
        .then(() => {
            // Optional: clean up if needed when closed
            savedPopupContent = null; // Clear saved state on close
            characterListContainer = null; // Clear container reference
        });

    // Need to wait briefly for the popup to be added to the DOM
    await delay(100); // Adjust delay if necessary

    characterListContainer = document.querySelector('.chub-list-popup');
    if (!characterListContainer) {
        console.error("Could not find character list container in popup!");
        return;
    }

    let clone = null;  // Store reference to the cloned image

    // Image zoom listener
     // Use event delegation on the container
    characterListContainer.addEventListener('click', function (event) {
        if (event.target.tagName === 'IMG' && event.target.classList.contains('chub-thumbnail')) {
            const image = event.target;

             // If the same image is clicked again while zoomed, remove clone
            if (clone && clone.src === image.src) {
                if (document.body.contains(clone)) {
                     document.body.removeChild(clone);
                }
                clone = null;
                return;
            }
            // If a different image is clicked or no clone exists, create/replace clone
            else if (clone && document.body.contains(clone)) {
                 document.body.removeChild(clone); // Remove previous clone first
                 clone = null;
            }


            const rect = image.getBoundingClientRect();

            clone = image.cloneNode(true);
            clone.style.position = 'fixed'; // Use fixed to account for scrolling
            clone.style.top = '50%';
            clone.style.left = '50%';
            // Calculate scale to fit viewport but be large
             const scaleX = window.innerWidth * 0.8 / image.naturalWidth;
             const scaleY = window.innerHeight * 0.8 / image.naturalHeight;
             const scale = Math.min(scaleX, scaleY, 4); // Max 4x scale, fit within 80% viewport

            clone.style.transform = `translate(-50%, -50%) scale(${scale})`;
            clone.style.zIndex = 99999;
            clone.style.objectFit = 'contain';
             clone.style.backgroundColor = 'rgba(0,0,0,0.7)'; // Optional backdrop
             clone.style.border = '2px solid white';
             clone.style.borderRadius = '5px';
             clone.classList.add('chub-zoomed-image'); // Add class for potential global click listener

            document.body.appendChild(clone);

             // Add listener to remove clone on next click *anywhere* except the clone itself
             // Use setTimeout to avoid capturing the same click that opened it
             setTimeout(() => {
                document.addEventListener('click', removeZoomedImageOnClick, { once: true, capture: true });
             }, 0);


            // Prevent this image click from immediately triggering the document listener
            event.stopPropagation();
        }
         // Download button listener
        else if (event.target.classList.contains('chub-download-btn')) {
            event.stopPropagation(); // Prevent triggering other listeners
            const source = event.target.getAttribute('data-source') || 'chub';

            if (source === 'aicc') {
                const id = event.target.getAttribute('data-id');
                const name = event.target.getAttribute('data-name');
                if (!id) {
                    console.error("Download button missing data-id attribute");
                    toastr.warning("Could not initiate download: character id missing.");
                    return;
                }
                downloadAICCCharacter(id, name);
                return;
            }

            if (source === 'cc') {
                const coverUrl = event.target.getAttribute('data-cover-url');
                const name = event.target.getAttribute('data-name');
                if (!coverUrl) {
                    console.error("Download button missing data-cover-url attribute");
                    toastr.warning("Could not initiate download: cover image URL missing.");
                    return;
                }
                downloadCCCharacter(coverUrl, name);
                return;
            }

            const fullPath = event.target.getAttribute('data-path');
            if (!fullPath) {
                console.error("Download button missing data-path attribute");
                toastr.warning("Could not initiate download: character path missing.");
                return;
            }
            if (source === 'ct') {
                const id = event.target.getAttribute('data-id');
                downloadCTCharacter(id, fullPath);
            } else {
                downloadCharacter(fullPath);
            }
        }
    });

     // Function to remove the zoomed image
     function removeZoomedImageOnClick(event) {
         if (clone && document.body.contains(clone)) {
             // Only remove if the click was outside the zoomed image itself
             if (!clone.contains(event.target)) {
                 document.body.removeChild(clone);
                 clone = null;
                  // Clean up listener just in case (though {once: true} should handle it)
                  document.removeEventListener('click', removeZoomedImageOnClick, { capture: true });
             } else {
                  // If clicked inside, re-attach listener for the *next* click
                  document.addEventListener('click', removeZoomedImageOnClick, { once: true, capture: true });
             }
         }
     }


    const executeCharacterSearchDebounced = debounce((options, source) => executeCharacterSearch(options, source), 600); // Slightly shorter debounce

    // --- Tab switching ---
    const tabButtons = document.querySelectorAll('[data-source-tab]');
    tabButtons.forEach(tabButton => {
        tabButton.addEventListener('click', () => {
            const newSource = tabButton.getAttribute('data-source-tab');
            if (newSource === activeSource) return;
            activeSource = newSource;

            tabButtons.forEach(btn => btn.classList.toggle('active', btn === tabButton));
            document.querySelectorAll('[data-source-panel]').forEach(panel => {
                panel.hidden = panel.getAttribute('data-source-panel') !== newSource;
            });

            const charactersBySource = { chub: chubCharacters, ct: ctCharacters, aicc: aiccCharacters, cc: ccCharacters };
            const currentCharacters = charactersBySource[newSource] || [];
            updateCharacterListInView(currentCharacters, newSource);
            if (currentCharacters.length === 0 && characterListContainer) {
                characterListContainer.innerHTML = '<div class="chub-no-characters-found">Perform a search to see characters.</div>';
            }
        });
    });

    // --- Event Listeners for Search Inputs ---
    const searchInputs = [
        'characterSearchInput', 'nameLikeInput', 'includeTags', 'excludeTags',
        'minTokensInput', 'maxTokensInput', 'minTagsInput', 'minUsersChattedInput', 'maxDaysAgoInput', 'minAiRatingInput', 'languageInput',
        'nsfwCheckbox', 'nsflCheckbox', 'nsfwOnlyCheckbox', 'requireImagesCheckbox',
        'requireExampleDialoguesCheckbox', 'requireAltGreetingsCheckbox', 'requireCustomPromptCheckbox',
        'requireExpressionsCheckbox', 'requireLoreCheckbox', 'requireLoreEmbeddedCheckbox',
        'requireLoreLinkedCheckbox', 'recommendedVerifiedCheckbox', 'inclusiveOrCheckbox', 'includeForksCheckbox',
        'sortOrder', 'sortAscCheckbox', 'resultsPerPage', 'pageNumber'
    ];

    const searchButton = document.getElementById('characterSearchButton');
    const pageUpButton = document.getElementById('pageUpButton');
    const pageDownButton = document.getElementById('pageDownButton');

    const handleSearch = async function (e) {
        console.debug('handleSearch triggered by:', e.target.id || e.type);

         // Prevent triggering search on every keypress in text fields unless Enter
         if (e.type === 'keyup' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
             return;
         }
         // Or if it's keydown that isn't Enter for text inputs
         if (e.type === 'keydown' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
              return;
          }


        const getVal = (id) => document.getElementById(id)?.value;
        const getChecked = (id) => document.getElementById(id)?.checked;
        const getInt = (id) => {
            const val = getVal(id);
            return val ? parseInt(val, 10) : null; // Return null if empty or invalid
        };
        const splitAndTrim = (id) => {
             const str = getVal(id);
             if (!str) return [];
             return str.split(',').map(tag => tag.trim()).filter(tag => tag); // Filter empty strings
         };

        let currentPage = getInt('pageNumber') || 1; // Default to 1 if invalid

        // Handle page button clicks
        if (e.target.id === 'pageUpButton' || e.target.closest('#pageUpButton')) {
            currentPage++;
        } else if (e.target.id === 'pageDownButton' || e.target.closest('#pageDownButton')) {
            currentPage--;
        }

        // Clamp page number
        currentPage = clamp(currentPage, 1, Number.MAX_SAFE_INTEGER);
        if (document.getElementById('pageNumber')) {
             document.getElementById('pageNumber').value = currentPage; // Update input field
        }


        // Gather all options
        const options = {
            searchTerm: getVal('characterSearchInput'),
            name_like: getVal('nameLikeInput'),
            includeTags: splitAndTrim('includeTags'),
            excludeTags: splitAndTrim('excludeTags'),
            min_tokens: getInt('minTokensInput'),
            max_tokens: getInt('maxTokensInput'),
            min_tags: getInt('minTagsInput'),
            min_users_chatted: getInt('minUsersChattedInput'),
            max_days_ago: getInt('maxDaysAgoInput'),
            min_ai_rating: getInt('minAiRatingInput'),
            language: getVal('languageInput'),

            nsfw: getChecked('nsfwCheckbox'),
            nsfl: getChecked('nsflCheckbox'),
            nsfw_only: getChecked('nsfwOnlyCheckbox'),
            require_images: getChecked('requireImagesCheckbox'),
            require_example_dialogues: getChecked('requireExampleDialoguesCheckbox'),
            require_alternate_greetings: getChecked('requireAltGreetingsCheckbox'),
            require_custom_prompt: getChecked('requireCustomPromptCheckbox'),
            require_expressions: getChecked('requireExpressionsCheckbox'),
            require_lore: getChecked('requireLoreCheckbox'),
            require_lore_embedded: getChecked('requireLoreEmbeddedCheckbox'),
            require_lore_linked: getChecked('requireLoreLinkedCheckbox'),
            recommended_verified: getChecked('recommendedVerifiedCheckbox'),
            inclusive_or: getChecked('inclusiveOrCheckbox'),
             include_forks: getChecked('includeForksCheckbox'), // Make sure this ID exists

            sort: getVal('sortOrder'),
            asc: getChecked('sortAscCheckbox'),
            first: getInt('resultsPerPage'), // Use 'first' for API
            page: currentPage
        };

        // Reset page to 1 if the trigger was not a pagination control
        if (e.target.id !== 'pageNumber' && e.target.id !== 'pageUpButton' && e.target.id !== 'pageDownButton' && !e.target.closest('#pageUpButton') && !e.target.closest('#pageDownButton')) {
             options.page = 1;
             if (document.getElementById('pageNumber')) {
                  document.getElementById('pageNumber').value = 1;
             }
        }


        executeCharacterSearchDebounced(options, 'chub');

         // Update settings in real-time for boolean flags and resultsPerPage
        if (document.getElementById('resultsPerPage') && options.first) {
             extension_settings.chub.findCount = options.first;
        }
         // Update boolean settings based on current checkbox state
         Object.keys(defaultSettings).forEach(key => {
             if (typeof defaultSettings[key] === 'boolean') {
                 const checkboxId = `${key}Checkbox`; // Assumes standard ID convention
                 // Special case for findCount mapped to resultsPerPage
                 if (key === 'findCount') return;

                  // Construct the ID based on common patterns
                  let elementId;
                 if (key === 'nsfw_only') elementId = 'nsfwOnlyCheckbox';
                 else if (key === 'inclusive_or') elementId = 'inclusiveOrCheckbox';
                 else if (key === 'recommended_verified') elementId = 'recommendedVerifiedCheckbox';
                 // ... add other non-standard IDs if necessary
                 else {
                     // Convert snake_case to camelCase for the ID prefix
                      const camelCaseKey = key.replace(/_([a-z])/g, g => g[1].toUpperCase());
                      elementId = `${camelCaseKey}Checkbox`;
                 }


                 const checkbox = document.getElementById(elementId);
                 if (checkbox) {
                      extension_settings.chub[key] = checkbox.checked;
                 }
             }
         });
    };


    // Add listeners to all relevant inputs
    searchInputs.forEach(inputId => {
        const element = document.getElementById(inputId);
        if (element) {
            const eventType = (element.type === 'checkbox' || element.tagName === 'SELECT') ? 'change' : 'keyup';
            element.addEventListener(eventType, handleSearch);
             // Also trigger search on 'change' for number inputs when they lose focus or value is committed
             if (element.type === 'number') {
                 element.addEventListener('change', handleSearch);
             }
             // Trigger search on Enter key for text inputs specifically
             if (element.type === 'text') {
                 element.addEventListener('keydown', (e) => {
                     if (e.key === 'Enter') {
                         handleSearch(e); // Trigger immediate search on Enter
                     }
                 });
             }
        } else {
            console.warn(`Element with ID ${inputId} not found for event listener.`);
        }
    });

    // Add listeners for buttons
    if (searchButton) searchButton.addEventListener('click', handleSearch);
    if (pageUpButton) pageUpButton.addEventListener('click', handleSearch);
    if (pageDownButton) pageDownButton.addEventListener('click', handleSearch);

    // --- Character Tavern search inputs ---
    const ctSearchInputs = [
        'ctSearchInput', 'ctIncludeTags', 'ctExcludeTags', 'ctMinTokensInput', 'ctMaxTokensInput',
        'ctRequireLoreCheckbox', 'ctRequireOcCheckbox', 'ctSortOrder', 'ctResultsPerPage', 'ctPageNumber',
    ];

    const ctSearchButton = document.getElementById('ctSearchButton');
    const ctPageUpButton = document.getElementById('ctPageUpButton');
    const ctPageDownButton = document.getElementById('ctPageDownButton');

    const handleCTSearch = async function (e) {
        console.debug('handleCTSearch triggered by:', e.target.id || e.type);

        if (e.type === 'keyup' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }
        if (e.type === 'keydown' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }

        const getVal = (id) => document.getElementById(id)?.value;
        const getChecked = (id) => document.getElementById(id)?.checked;
        const getInt = (id) => {
            const val = getVal(id);
            return val ? parseInt(val, 10) : null;
        };
        const splitAndTrim = (id) => {
            const str = getVal(id);
            if (!str) return [];
            return str.split(',').map(tag => tag.trim()).filter(tag => tag);
        };

        let currentPage = getInt('ctPageNumber') || 1;

        if (e.target.id === 'ctPageUpButton' || e.target.closest('#ctPageUpButton')) {
            currentPage++;
        } else if (e.target.id === 'ctPageDownButton' || e.target.closest('#ctPageDownButton')) {
            currentPage--;
        }

        currentPage = clamp(currentPage, 1, Number.MAX_SAFE_INTEGER);
        if (document.getElementById('ctPageNumber')) {
            document.getElementById('ctPageNumber').value = currentPage;
        }

        const options = {
            searchTerm: getVal('ctSearchInput'),
            includeTags: splitAndTrim('ctIncludeTags'),
            excludeTags: splitAndTrim('ctExcludeTags'),
            min_tokens: getInt('ctMinTokensInput'),
            max_tokens: getInt('ctMaxTokensInput'),
            require_lore: getChecked('ctRequireLoreCheckbox'),
            require_oc: getChecked('ctRequireOcCheckbox'),
            sort: getVal('ctSortOrder'),
            first: getInt('ctResultsPerPage'),
            page: currentPage,
        };

        if (e.target.id !== 'ctPageNumber' && e.target.id !== 'ctPageUpButton' && e.target.id !== 'ctPageDownButton' && !e.target.closest('#ctPageUpButton') && !e.target.closest('#ctPageDownButton')) {
            options.page = 1;
            if (document.getElementById('ctPageNumber')) {
                document.getElementById('ctPageNumber').value = 1;
            }
        }

        executeCharacterSearchDebounced(options, 'ct');

        if (document.getElementById('ctResultsPerPage') && options.first) {
            extension_settings.chub.findCount = options.first;
        }
    };

    ctSearchInputs.forEach(inputId => {
        const element = document.getElementById(inputId);
        if (element) {
            const eventType = (element.type === 'checkbox' || element.tagName === 'SELECT') ? 'change' : 'keyup';
            element.addEventListener(eventType, handleCTSearch);
            if (element.type === 'number') {
                element.addEventListener('change', handleCTSearch);
            }
            if (element.type === 'text') {
                element.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        handleCTSearch(e);
                    }
                });
            }
        } else {
            console.warn(`Element with ID ${inputId} not found for event listener.`);
        }
    });

    if (ctSearchButton) ctSearchButton.addEventListener('click', handleCTSearch);
    if (ctPageUpButton) ctPageUpButton.addEventListener('click', handleCTSearch);
    if (ctPageDownButton) ctPageDownButton.addEventListener('click', handleCTSearch);

    // --- AICharacterCards search inputs ---
    const aiccSearchInputs = [
        'aiccSearchInput', 'aiccIncludeTags', 'aiccNsfwFilter', 'aiccSortOrder', 'aiccResultsPerPage', 'aiccPageNumber',
    ];

    const aiccSearchButton = document.getElementById('aiccSearchButton');
    const aiccPageUpButton = document.getElementById('aiccPageUpButton');
    const aiccPageDownButton = document.getElementById('aiccPageDownButton');

    const handleAICCSearch = async function (e) {
        console.debug('handleAICCSearch triggered by:', e.target.id || e.type);

        if (e.type === 'keyup' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }
        if (e.type === 'keydown' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }

        const getVal = (id) => document.getElementById(id)?.value;
        const getInt = (id) => {
            const val = getVal(id);
            return val ? parseInt(val, 10) : null;
        };
        const splitAndTrim = (id) => {
            const str = getVal(id);
            if (!str) return [];
            return str.split(',').map(tag => tag.trim()).filter(tag => tag);
        };

        let currentPage = getInt('aiccPageNumber') || 1;

        if (e.target.id === 'aiccPageUpButton' || e.target.closest('#aiccPageUpButton')) {
            currentPage++;
        } else if (e.target.id === 'aiccPageDownButton' || e.target.closest('#aiccPageDownButton')) {
            currentPage--;
        }

        currentPage = clamp(currentPage, 1, Number.MAX_SAFE_INTEGER);
        if (document.getElementById('aiccPageNumber')) {
            document.getElementById('aiccPageNumber').value = currentPage;
        }

        const options = {
            searchTerm: getVal('aiccSearchInput'),
            includeTags: splitAndTrim('aiccIncludeTags'),
            nsfwFilter: getVal('aiccNsfwFilter'),
            sort: getVal('aiccSortOrder'),
            first: getInt('aiccResultsPerPage'),
            page: currentPage,
        };

        if (e.target.id !== 'aiccPageNumber' && e.target.id !== 'aiccPageUpButton' && e.target.id !== 'aiccPageDownButton' && !e.target.closest('#aiccPageUpButton') && !e.target.closest('#aiccPageDownButton')) {
            options.page = 1;
            if (document.getElementById('aiccPageNumber')) {
                document.getElementById('aiccPageNumber').value = 1;
            }
        }

        executeCharacterSearchDebounced(options, 'aicc');

        if (document.getElementById('aiccResultsPerPage') && options.first) {
            extension_settings.chub.findCount = options.first;
        }
    };

    aiccSearchInputs.forEach(inputId => {
        const element = document.getElementById(inputId);
        if (element) {
            const eventType = (element.type === 'checkbox' || element.tagName === 'SELECT') ? 'change' : 'keyup';
            element.addEventListener(eventType, handleAICCSearch);
            if (element.type === 'number') {
                element.addEventListener('change', handleAICCSearch);
            }
            if (element.type === 'text') {
                element.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        handleAICCSearch(e);
                    }
                });
            }
        } else {
            console.warn(`Element with ID ${inputId} not found for event listener.`);
        }
    });

    if (aiccSearchButton) aiccSearchButton.addEventListener('click', handleAICCSearch);
    if (aiccPageUpButton) aiccPageUpButton.addEventListener('click', handleAICCSearch);
    if (aiccPageDownButton) aiccPageDownButton.addEventListener('click', handleAICCSearch);

    // --- CharacterCard.com search inputs ---
    const ccSearchInputs = ['ccSearchInput', 'ccIncludeTags'];
    const ccSearchButton = document.getElementById('ccSearchButton');

    const handleCCSearch = async function (e) {
        console.debug('handleCCSearch triggered by:', e.target.id || e.type);

        if (e.type === 'keyup' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }
        if (e.type === 'keydown' && e.key !== 'Enter' && (e.target.type === 'text' || e.target.type === 'number')) {
            return;
        }

        const getVal = (id) => document.getElementById(id)?.value;
        const splitAndTrim = (id) => {
            const str = getVal(id);
            if (!str) return [];
            return str.split(',').map(tag => tag.trim()).filter(tag => tag);
        };

        const options = {
            searchTerm: getVal('ccSearchInput'),
            includeTags: splitAndTrim('ccIncludeTags'),
        };

        executeCharacterSearchDebounced(options, 'cc');
    };

    ccSearchInputs.forEach(inputId => {
        const element = document.getElementById(inputId);
        if (element) {
            element.addEventListener('keyup', handleCCSearch);
            element.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    handleCCSearch(e);
                }
            });
        } else {
            console.warn(`Element with ID ${inputId} not found for event listener.`);
        }
    });

    if (ccSearchButton) ccSearchButton.addEventListener('click', handleCCSearch);

    // Trigger initial search if desired (optional)
    // handleSearch({ target: { id: 'initial-load' } }); // Uncomment to search on open
}


/**
 * Fetches a character *avatar image* by making an API call.
 * Note: This is less efficient than getting the avatar URL from the search results.
 * Kept here for reference or if direct avatar fetch is needed for some reason.
 *
 * @async
 * @function
 * @param {string} fullPath - The unique path/reference for the character.
 * @returns {Promise<Blob|null>} - Resolves with a Blob of the avatar image or null on failure.
 */
async function getCharacterAvatar(fullPath) {
    // Prefer the dedicated avatar endpoint if it exists and works
     const avatarUrl = `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`;
     try {
         let response = await fetch(avatarUrl, { method: "GET" });

         if (!response.ok) {
             console.log(`Primary avatar request failed for ${fullPath} (${response.status}), trying download endpoint as fallback for image.`);
              // Fallback: Use the download endpoint - less ideal as it downloads the whole card
              response = await fetch(
                  API_ENDPOINT_DOWNLOAD,
                  {
                      method: "POST",
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ fullPath: fullPath, format: "tavern", version: "main" }), // Or format specifically for image? Check API
                  }
              );
         }

         if (!response.ok) {
             console.error(`Failed to fetch avatar for ${fullPath} from both endpoints.`);
             return null; // Return null if fetch fails completely
         }

         // Check content type to ensure it's an image
         const contentType = response.headers.get('content-type');
         if (contentType && contentType.startsWith('image/')) {
            const data = await response.blob();
            return data;
         } else {
             console.warn(`Received non-image content type (${contentType}) when fetching avatar for ${fullPath}.`);
             // If using the download endpoint as fallback, this might be JSON/Tavern card data.
             // In a real scenario, you'd parse this and extract the image data if possible,
             // but for simplicity here, we return null if it's not directly an image.
             return null;
         }

     } catch (error) {
         console.error(`Error fetching avatar for ${fullPath}:`, error);
         return null; // Return null on network or other errors
     }
}

/**
 * jQuery document-ready block:
 * - Adds the Chub search button to the UI.
 * - Attaches the click handler to open the search popup.
 * - Loads extension settings.
 */
jQuery(async () => {
    // Add button
    $("#external_import_button").after('<button id="search-chub" class="menu_button fa-solid fa-cloud-bolt faSmallFontSquareFix" title="Search Chub Characters (Work-SillyTavern-Chub-Search)"></button>');

    // Add click listener
    $("#search-chub").on("click", function () {
        openSearchPopup();
    });

    // Load settings
    await loadSettings(); // Ensure settings are loaded before the popup might be opened
});

