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
 * Updates the character list in the view based on provided characters.
 * @param {Array} characters - A list of character data objects to be rendered in the view.
 */
function updateCharacterListInView(characters) {
    if (characterListContainer) {
        characterListContainer.innerHTML = characters.map(generateCharacterListItem).join('');
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
 * Searches for characters based on the provided options and manages the UI during the search.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function searchCharacters(options) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        console.log('Character list container is not in the DOM, removing reference');
        characterListContainer = null;
    }
    // grey out the character-list-popup while we're searching
    if (characterListContainer) {
        characterListContainer.classList.add('searching');
    }
    console.log('Searching for characters with options:', options);
    const characters = await fetchCharactersBySearch(options);
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
 * @returns {Promise<void>} - Resolves once the character list has been updated in the view.
 */
async function executeCharacterSearch(options) {
    // Clear the previous search result first
    chubCharacters = [];
    updateCharacterListInView(chubCharacters);  // Resetting character list before fetching new characters

    let characters  = await searchCharacters(options);

    if (characters && characters.length > 0) {
        console.log(`Found ${characters.length} characters. Updating character list.`);
        updateCharacterListInView(characters);
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
 * @returns {string} - Returns an HTML string representation of the character list item.
 */
function generateCharacterListItem(character, index) {
    // Use a placeholder if the image URL is invalid or missing
    const imageUrl = character.url && character.url !== `${extensionFolderPath}placeholder.png` ? character.url : `${extensionFolderPath}placeholder.png`;
    const placeholderImg = `${extensionFolderPath}placeholder.png`; // Define placeholder path

    return `
        <div class="chub-character-item" data-index="${index}">
            <img class="chub-thumbnail" src="${imageUrl}" onerror="this.onerror=null; this.src='${placeholderImg}';">
            <div class="chub-info">
                <a href="https://chub.ai/characters/${character.fullPath}" target="_blank" title="View on Chub.ai: ${character.name}"><div class="chub-name">${character.name || "Default Name"}</div></a>
                <a href="https://chub.ai/users/${character.author}" target="_blank" title="View author on Chub.ai: ${character.author}">
                 <span class="chub-author">by ${character.author}</span>
                </a>
                <div class="chub-description">${character.description}</div>
                <div class="chub-tags">${character.tags.slice(0, 8).map(tag => `<span class="chub-tag">${tag}</span>`).join('')}</div>
            </div>
            <div data-path="${character.fullPath}" class="menu_button fa-solid fa-cloud-arrow-down faSmallFontSquareFix chub-download-btn" title="Import Character"></div>
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

    return `
<div class="chub-wrapper" id="list-and-search-wrapper">
    <div class="chub-list-popup">
        ${chubCharacters.map((character, index) => generateCharacterListItem(character, index)).join('')}
        <!-- Placeholder message when list is empty -->
        ${chubCharacters.length === 0 ? '<div class="chub-no-characters-found">Perform a search to see characters.</div>' : ''}
    </div>
    <hr class="chub-hr">
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
            const fullPath = event.target.getAttribute('data-path');
            if (fullPath) {
                 downloadCharacter(fullPath);
             } else {
                 console.error("Download button missing data-path attribute");
                 toastr.warning("Could not initiate download: character path missing.");
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


    const executeCharacterSearchDebounced = debounce((options) => executeCharacterSearch(options), 600); // Slightly shorter debounce

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


        executeCharacterSearchDebounced(options);

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

