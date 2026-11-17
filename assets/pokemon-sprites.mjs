/**
 * ES Module Wrapper for Antigravity Pokémon Agent Pets (Authentic Original Animated Sprites)
 * File: assets/pokemon-sprites.mjs
 */
import './pokemon-sprites.js';

export const PokemonPets = globalThis.PokemonPets;
export const OFFICIAL_SPRITES = PokemonPets.OFFICIAL_SPRITES;
export const SPRITE_MODES = PokemonPets.SPRITE_MODES;
export const SPECIES = PokemonPets.SPECIES;
export const SPECIES_LIST = PokemonPets.SPECIES_LIST;
export const STATES = PokemonPets.STATES;
export const CORE_STATES = PokemonPets.CORE_STATES;
export const normalizeSpecies = PokemonPets.normalizeSpecies;
export const normalizeState = PokemonPets.normalizeState;
export const normalizeSpriteMode = PokemonPets.normalizeSpriteMode;
export const getAuthenticGifDataUri = PokemonPets.getAuthenticGifDataUri;
export const resolveSpeciesForAgent = PokemonPets.resolveSpeciesForAgent;
export const getSvgMarkup = PokemonPets.getSvgMarkup;
export const getSvgDataUri = PokemonPets.getSvgDataUri;
export const injectStyles = PokemonPets.injectStyles;
export const mountPet = PokemonPets.mountPet;

export default PokemonPets;
