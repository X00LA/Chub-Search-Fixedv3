# CHUB-SEARCH becomes MULTI-CHAR-CARD SEARCH

## What's new? (old)
- 30 char cards on one page
- fix page switching
- fix cards download (thanks for this, fork "Fixed-SillyTavern-Chub-Search")
- limit of 8 tags
- full card description
- overhauled search popup UI (combined search fields, single sort/pagination/search toolbar row)
- added [Character Tavern](https://character-tavern.com/), [AICharacterCards](https://aicharactercards.com/), [CharacterCard.com](https://charactercard.com/), and [CharaVault](https://charavault.net/) as additional search sources, each in their own tab
## What it is?
SillyTavern Chub Search provides a quick and easy way to search for new cards from [CHUB](https://www.chub.ai/about), [Character Tavern](https://character-tavern.com/), [AICharacterCards](https://aicharactercards.com/), [CharacterCard.com](https://charactercard.com/), and [CharaVault](https://charavault.net/) from the comfort of your tavern.

![image](https://github.com/city-unit/SillyTavern-Chub-Search/assets/140349364/648e43ae-3ed0-4673-b024-f4ba7846998c)


## Installation and Usage

Utilize SillyTavern's third party extension importer to install.

![image](https://github.com/city-unit/st-auto-tagger/assets/1860540/188b8ba5-c121-4357-96f8-a45bd60cf8a5)

To use the search, click the thunderbolt icon. The popup opens with a tab for each source — **Chub**, **Character Tavern**, **AICharacterCards**, **CharacterCard.com**, and **CharaVault** — each with its own search fields and filters (tags, NSFW, tokens, sorting, etc. where that site's API supports them). The CharacterCard.com tab only supports text and tag search (no sorting/pagination — the site doesn't expose a working method for either outside its own UI).

![image](https://github.com/city-unit/st-chub-search/assets/140349364/a8857619-54df-43f8-b42d-2635d4c5a412)

Enter your search criteria and click "Search" (or press Enter in a text field) to fetch results for the active tab. Click the download icon on a result to import it directly into SillyTavern.

## Prerequisites

This extension requires >= SillyTavern commit [01e38be](https://github.com/SillyTavern/SillyTavern/commit/01e38be408b4bd40792c3cf86d353ecad60f7ea2) to function.

## Character Tavern, AICharacterCards, CharacterCard.com & CharaVault support

Besides Chub, this extension can also search and import characters from [Character Tavern](https://character-tavern.com/), [AICharacterCards](https://aicharactercards.com/), [CharacterCard.com](https://charactercard.com/), and [CharaVault](https://charavault.net/) via extra tabs in the search popup.

None of these sites send CORS headers, so the browser blocks direct requests to them. To work around this, searches and imports for all four are routed through SillyTavern's built-in CORS proxy. This proxy is **disabled by default**, so it needs to be enabled once:

- In `config.yaml`, set:
  ```yaml
  enableCorsProxy: true
  ```
  or start SillyTavern with the `--corsProxy` command line flag.
- Restart the SillyTavern server after changing this setting.

If the proxy is not enabled, searching or importing from any of these sites will show a toast error explaining that `enableCorsProxy` needs to be turned on. The Chub tab is unaffected and works without this setting.

Note: Character Tavern, AICharacterCards, and CharacterCard.com have undocumented APIs that were reverse-engineered from each site's own JavaScript bundles/network traffic — they may break if any of them changes how their site works. CharacterCard.com in particular has no classic REST API at all; its search results are pulled out of the raw React Server Component payload the site renders with, which is more fragile than a real API and does not currently support sorting or pagination. CharaVault is the exception — it has an [officially documented REST API](https://charavault.net/developers) with proper search, filtering, sorting, and pagination, so that tab is the most robust of the four.

## Support and Contributions

If you encounter any issues while using this extension, please file an issue on GitHub. If you'd like to contribute to this project, feel free to fork the repository and submit a pull request.

## License

SillyTavern Chub Search is available under the [MIT License](https://github.com/city-unit/st-chub-search/blob/main/LICENSE).
