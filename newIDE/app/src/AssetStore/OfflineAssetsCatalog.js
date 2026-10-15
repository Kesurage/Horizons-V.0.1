// @flow
import {
  type AssetShortHeader,
  type Asset,
  type PublicAssetPacks,
  type PublicAssetPack,
  type Author,
  type License,
} from '../Utils/GDevelopServices/Asset';
import { type Filters } from '../Utils/GDevelopServices/Filters';

const PLAYER_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="none"/><rect x="16" y="8" width="32" height="32" rx="8" fill="%234f46e5"/><rect x="22" y="16" width="6" height="8" rx="3" fill="%23ffffff"/><rect x="36" y="16" width="6" height="8" rx="3" fill="%23ffffff"/><circle cx="25" cy="20" r="2" fill="%230f172a"/><circle cx="39" cy="20" r="2" fill="%230f172a"/><path d="M26 30 Q32 35 38 30" stroke="%23ffffff" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="18" y="40" width="28" height="18" rx="6" fill="%233b82f6"/><rect x="20" y="58" width="10" height="6" rx="2" fill="%231e293b"/><rect x="34" y="58" width="10" height="6" rx="2" fill="%231e293b"/></svg>`;

const COIN_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="28" fill="%23f59e0b" stroke="%23b45309" stroke-width="4"/><circle cx="32" cy="32" r="20" fill="%23fbbf24"/><text x="32" y="40" font-size="26" font-family="sans-serif" font-weight="bold" fill="%2378350f" text-anchor="middle">$</text></svg>`;

const PLATFORM_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="4" fill="%2315803d"/><rect x="0" y="14" width="64" height="50" rx="2" fill="%2378350f"/><rect x="4" y="18" width="26" height="12" fill="%2392400e" opacity="0.6"/><rect x="34" y="34" width="26" height="12" fill="%2392400e" opacity="0.6"/><path d="M0 14 L8 22 L16 14 L24 22 L32 14 L40 22 L48 14 L56 22 L64 14" fill="%2316a34a"/></svg>`;

const SPIKES_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M0 64 L16 16 L32 64 L48 16 L64 64 Z" fill="%23ef4444" stroke="%23991b1b" stroke-width="2"/></svg>`;

const ENEMY_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M12 48 Q32 12 52 48 Q32 58 12 48 Z" fill="%23ec4899" stroke="%23be185d" stroke-width="3"/><circle cx="24" cy="34" r="5" fill="%23ffffff"/><circle cx="40" cy="34" r="5" fill="%23ffffff"/><circle cx="26" cy="34" r="2.5" fill="%230f172a"/><circle cx="42" cy="34" r="2.5" fill="%230f172a"/><path d="M26 44 Q32 40 38 44" stroke="%23831843" stroke-width="2" fill="none"/></svg>`;

// Minimal valid 44-byte 8kHz 8-bit mono PCM WAV for jump and coin audio effects
const JUMP_AUDIO_DATA = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAAAAf35+f39/f39/f39/f38=';
const COIN_AUDIO_DATA = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAAAAf4CAgICAgICAgICAgIA=';

export const OFFLINE_AUTHORS: Array<Author> = [
  { name: 'Horizons Team' },
  { name: 'Kenney' },
];

export const OFFLINE_LICENSES: Array<License> = [
  { name: 'CC0 (public domain)', website: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  { name: 'MIT', website: 'https://opensource.org/licenses/MIT' },
];

export const OFFLINE_ASSET_SHORT_HEADERS: Array<AssetShortHeader> = [
  {
    id: 'offline-player',
    name: 'Hero Player (Platformer)',
    shortDescription: 'Ready-to-play character with platformer controls and jump logic.',
    previewImageUrls: [PLAYER_SVG],
    tags: ['character', 'player', 'hero', 'platformer', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 64,
    height: 64,
  },
  {
    id: 'offline-platform',
    name: 'Grass Platform',
    shortDescription: 'Solid ground obstacle that player characters can walk and jump on.',
    previewImageUrls: [PLATFORM_SVG],
    tags: ['platform', 'ground', 'tile', 'level', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 64,
    height: 64,
  },
  {
    id: 'offline-coin',
    name: 'Golden Coin (Collectible)',
    shortDescription: 'Score item that sparkles and can be gathered for points.',
    previewImageUrls: [COIN_SVG],
    tags: ['coin', 'pickup', 'collectible', 'score', 'gold', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 64,
    height: 64,
  },
  {
    id: 'offline-spikes',
    name: 'Hazard Spikes',
    shortDescription: 'Dangerous trap obstacle that damages or defeats players.',
    previewImageUrls: [SPIKES_SVG],
    tags: ['hazard', 'spikes', 'trap', 'obstacle', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 64,
    height: 64,
  },
  {
    id: 'offline-enemy',
    name: 'Slime Monster',
    shortDescription: 'Animated opponent to place in levels as patrol challenge.',
    previewImageUrls: [ENEMY_SVG],
    tags: ['enemy', 'monster', 'slime', 'opponent', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'sprite',
    animationsCount: 1,
    maxFramesCount: 1,
    width: 64,
    height: 64,
  },
  {
    id: 'offline-jump-sound',
    name: 'Jump Sound Effect',
    shortDescription: 'Classic arcade jump sound for character actions.',
    previewImageUrls: [PLAYER_SVG],
    tags: ['audio', 'sound', 'jump', 'sfx', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'audio',
    animationsCount: 0,
    maxFramesCount: 0,
    width: 32,
    height: 32,
  },
  {
    id: 'offline-coin-sound',
    name: 'Coin Pickup Sound',
    shortDescription: 'Chime sound for picking up coins or achieving objectives.',
    previewImageUrls: [COIN_SVG],
    tags: ['audio', 'sound', 'coin', 'pickup', 'sfx', 'offline'],
    license: 'CC0 (public domain)',
    authors: ['Horizons Team'],
    objectType: 'audio',
    animationsCount: 0,
    maxFramesCount: 0,
    width: 32,
    height: 32,
  },
];

export const OFFLINE_ASSET_PACKS: PublicAssetPacks = {
  starterPacks: [
    {
      name: 'Horizons Offline Starter Pack',
      tag: 'offline-starter',
      category: '2d',
      thumbnailUrl: PLAYER_SVG,
    },
  ],
  categories: [
    {
      name: '2D Assets',
      category: '2d',
    },
  ],
};

export const OFFLINE_FILTERS: Filters = {
  allTags: ['character', 'player', 'platform', 'ground', 'coin', 'collectible', 'hazard', 'enemy', 'audio', 'offline'],
  defaultTags: ['offline', 'player', 'platform', 'coin'],
  tagsTree: [],
};

export const getOfflineFullAsset = (assetId: string): ?Asset => {
  if (assetId === 'offline-player') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[0],
      description: 'Ready-to-play character with platformer controls and jump physics.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'HeroPlayer',
            type: 'Sprite',
            animations: [
              {
                name: 'idle',
                directions: [
                  {
                    timeBetweenFrames: 0.1,
                    looping: true,
                    sprites: [
                      {
                        hasCustomCollisionMask: false,
                        image: 'hero_player.png',
                        points: [],
                        originPoint: { name: 'origine', x: 0, y: 0 },
                        centerPoint: { automatic: true, name: 'centre', x: 32, y: 32 },
                        customCollisionMask: [],
                      },
                    ],
                  },
                ],
              },
            ],
            behaviors: [
              {
                name: 'PlatformerObject',
                type: 'PlatformBehavior::PlatformerObjectBehavior',
                gravity: 1000,
                maxFallingSpeed: 700,
                acceleration: 1500,
                deceleration: 1500,
                maxSpeed: 350,
                jumpSpeed: 600,
                canGrabPlatforms: false,
                ignoreDefaultControls: false,
              },
            ],
          },
          resources: [
            {
              name: 'hero_player.png',
              kind: 'image',
              file: PLAYER_SVG,
              metadata: '',
              origin: {
                name: 'hero_player.png',
                identifier: 'offline-player',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-platform') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[1],
      description: 'Solid platform ground tile for player walking and jumping.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'GrassPlatform',
            type: 'Sprite',
            animations: [
              {
                name: 'idle',
                directions: [
                  {
                    timeBetweenFrames: 0.1,
                    looping: true,
                    sprites: [
                      {
                        hasCustomCollisionMask: false,
                        image: 'grass_platform.png',
                        points: [],
                        originPoint: { name: 'origine', x: 0, y: 0 },
                        centerPoint: { automatic: true, name: 'centre', x: 32, y: 32 },
                        customCollisionMask: [],
                      },
                    ],
                  },
                ],
              },
            ],
            behaviors: [
              {
                name: 'Platform',
                type: 'PlatformBehavior::PlatformBehavior',
                canBeJumpedThrough: false,
                isLedge: false,
              },
            ],
          },
          resources: [
            {
              name: 'grass_platform.png',
              kind: 'image',
              file: PLATFORM_SVG,
              metadata: '',
              origin: {
                name: 'grass_platform.png',
                identifier: 'offline-platform',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-coin') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[2],
      description: 'Sparkling golden coin collectible.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'GoldCoin',
            type: 'Sprite',
            animations: [
              {
                name: 'idle',
                directions: [
                  {
                    timeBetweenFrames: 0.1,
                    looping: true,
                    sprites: [
                      {
                        hasCustomCollisionMask: false,
                        image: 'gold_coin.png',
                        points: [],
                        originPoint: { name: 'origine', x: 0, y: 0 },
                        centerPoint: { automatic: true, name: 'centre', x: 32, y: 32 },
                        customCollisionMask: [],
                      },
                    ],
                  },
                ],
              },
            ],
            behaviors: [],
          },
          resources: [
            {
              name: 'gold_coin.png',
              kind: 'image',
              file: COIN_SVG,
              metadata: '',
              origin: {
                name: 'gold_coin.png',
                identifier: 'offline-coin',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-spikes') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[3],
      description: 'Hazard spikes trap obstacle.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'HazardSpikes',
            type: 'Sprite',
            animations: [
              {
                name: 'idle',
                directions: [
                  {
                    timeBetweenFrames: 0.1,
                    looping: true,
                    sprites: [
                      {
                        hasCustomCollisionMask: false,
                        image: 'hazard_spikes.png',
                        points: [],
                        originPoint: { name: 'origine', x: 0, y: 0 },
                        centerPoint: { automatic: true, name: 'centre', x: 32, y: 32 },
                        customCollisionMask: [],
                      },
                    ],
                  },
                ],
              },
            ],
            behaviors: [],
          },
          resources: [
            {
              name: 'hazard_spikes.png',
              kind: 'image',
              file: SPIKES_SVG,
              metadata: '',
              origin: {
                name: 'hazard_spikes.png',
                identifier: 'offline-spikes',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-enemy') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[4],
      description: 'Slime monster enemy challenge.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'SlimeMonster',
            type: 'Sprite',
            animations: [
              {
                name: 'idle',
                directions: [
                  {
                    timeBetweenFrames: 0.1,
                    looping: true,
                    sprites: [
                      {
                        hasCustomCollisionMask: false,
                        image: 'slime_monster.png',
                        points: [],
                        originPoint: { name: 'origine', x: 0, y: 0 },
                        centerPoint: { automatic: true, name: 'centre', x: 32, y: 32 },
                        customCollisionMask: [],
                      },
                    ],
                  },
                ],
              },
            ],
            behaviors: [],
          },
          resources: [
            {
              name: 'slime_monster.png',
              kind: 'image',
              file: ENEMY_SVG,
              metadata: '',
              origin: {
                name: 'slime_monster.png',
                identifier: 'offline-enemy',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-jump-sound') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[5],
      description: 'Arcade jump sound effect.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'JumpSound',
            type: 'Sprite',
            animations: [],
            behaviors: [],
          },
          resources: [
            {
              name: 'jump_sfx.wav',
              kind: 'audio',
              file: JUMP_AUDIO_DATA,
              metadata: '',
              origin: {
                name: 'jump_sfx.wav',
                identifier: 'offline-jump-sound',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  if (assetId === 'offline-coin-sound') {
    return {
      ...OFFLINE_ASSET_SHORT_HEADERS[6],
      description: 'Coin pickup chime sound effect.',
      gdevelopVersion: '5.0.0',
      version: '1.0.0',
      objectAssets: [
        {
          object: {
            name: 'CoinSound',
            type: 'Sprite',
            animations: [],
            behaviors: [],
          },
          resources: [
            {
              name: 'coin_sfx.wav',
              kind: 'audio',
              file: COIN_AUDIO_DATA,
              metadata: '',
              origin: {
                name: 'coin_sfx.wav',
                identifier: 'offline-coin-sound',
              },
            },
          ],
          requiredExtensions: [],
        },
      ],
    };
  }

  return null;
};
