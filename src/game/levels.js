// The built-in cups. Each level is a loop of control points in metres; the
// game smooths them into a road. A third number on a point is its height. Medal times are worked out in medals.js.

export const LEVELS = [
  {
    id: 'sunny-meadows',
    name: 'Sunny Meadows',
    blurb: 'A wide, friendly loop with a gentle hill, one jump and one gap.',
    theme: 'meadow',
    width: 16,
    laps: 3,
    checkpoints: 6,
    points: [
      [0, -80], [70, -78], [118, -45], [122, 15, 3], [85, 62, 6], [25, 72, 4],
      [-30, 55], [-80, 70], [-125, 30], [-120, -35], [-75, -76],
    ],
    pads: [{ u: 0.03, lat: 0 }, { u: 0.5, lat: 0.2 }],
    obstacles: [
      { type: 'ramp', u: 0.36, lat: 0 }, { type: 'gap', u: 0.9, lat: 0 },
      { type: 'cone', u: 0.2, lat: -0.45 }, { type: 'cone', u: 0.21, lat: -0.2 }, { type: 'tyres', u: 0.62, lat: 0.5 }, { type: 'cone', u: 0.8, lat: 0.4 }],
  },
  {
    id: 'dusty-canyon',
    name: 'Dusty Canyon',
    blurb: 'Fast sweepers and a tricky S-bend through the dunes.',
    theme: 'desert',
    width: 15,
    laps: 3,
    checkpoints: 8,
    points: [
      [0, -120], [85, -118], [150, -80], [160, -10], [110, 30], [55, 25, 4],
      [20, 65, 9], [55, 115, 12], [20, 160, 9], [-50, 150, 4], [-80, 95], [-60, 35],
      [-110, 5], [-165, -30], [-150, -95], [-80, -122],
    ],
    pads: [{ u: 0.02, lat: 0 }, { u: 0.36, lat: -0.3 }, { u: 0.83, lat: 0 }],
    obstacles: [
      { type: 'ramp', u: 0.44, lat: 0 }, { type: 'gap', u: 0.62, lat: 0 }, { type: 'gap', u: 0.88, lat: 0 },
      { type: 'tyres', u: 0.12, lat: -0.5 }, { type: 'cone', u: 0.27, lat: 0.3 }, { type: 'cone', u: 0.28, lat: 0.55 }, { type: 'oil', u: 0.52, lat: 0.2 }, { type: 'tyres', u: 0.7, lat: 0.45 }, { type: 'cone', u: 0.92, lat: -0.4 }],
  },
  {
    id: 'frostbite-pass',
    name: 'Frostbite Pass',
    blurb: 'Hairpins on ice. Less grip, more sliding.',
    theme: 'snow',
    width: 15,
    laps: 2,
    checkpoints: 9,
    points: [
      [0, -130], [90, -128], [150, -95], [150, -40], [95, -25], [40, -45],
      [5, -15], [35, 30], [110, 35], [160, 75, 6], [140, 135, 11], [70, 150, 13],
      [10, 120, 9], [-45, 140, 4], [-110, 125], [-140, 70], [-95, 30], [-60, -10],
      [-120, -40], [-150, -95], [-90, -130],
    ],
    pads: [{ u: 0.02, lat: 0 }, { u: 0.47, lat: 0 }, { u: 0.9, lat: 0.2 }],
    obstacles: [
      { type: 'ramp', u: 0.22, lat: 0 }, { type: 'gap', u: 0.52, lat: 0 }, { type: 'gap', u: 0.86, lat: 0 },
      { type: 'oil', u: 0.15, lat: -0.3 }, { type: 'tyres', u: 0.3, lat: 0.5 }, { type: 'cone', u: 0.41, lat: -0.5 }, { type: 'cone', u: 0.42, lat: -0.25 }, { type: 'oil', u: 0.6, lat: 0.35 }, { type: 'tyres', u: 0.78, lat: -0.5 }, { type: 'cone', u: 0.95, lat: 0.4 }],
  },
  {
    id: 'neon-nights',
    name: 'Neon Nights',
    blurb: 'A figure-eight under the lights, with a bridge over the crossing.',
    theme: 'neon',
    width: 14,
    laps: 3,
    checkpoints: 10,
    points: [
      [0, 0], [60, -50], [130, -75], [185, -40], [185, 30], [130, 70],
      [60, 50, 6], [0, 0, 10.5], [-60, -50, 6], [-130, -75], [-190, -35], [-185, 40],
      [-125, 80], [-60, 50],
    ],
    pads: [{ u: 0.23, lat: 0 }, { u: 0.73, lat: 0 }, { u: 0.48, lat: 0 }],
    obstacles: [
      { type: 'gap', u: 0.2, lat: 0 }, { type: 'ramp', u: 0.66, lat: 0 }, { type: 'gap', u: 0.86, lat: 0 },
      { type: 'tyres', u: 0.1, lat: 0.5 }, { type: 'oil', u: 0.3, lat: -0.3 }, { type: 'cone', u: 0.4, lat: 0.45 }, { type: 'cone', u: 0.41, lat: 0.2 }, { type: 'tyres', u: 0.6, lat: -0.5 }, { type: 'oil', u: 0.82, lat: 0.3 }, { type: 'cone', u: 0.9, lat: -0.45 }],
  },
];

export const KART_COLORS = ['#ff3b3b', '#2f8bff', '#ffd23b', '#3ddc6b', '#ff7ad9', '#ff8a2a', '#9b6bff', '#2fe0d0'];

export const AI_NAMES = ['Blaze', 'Pixel', 'Turbo', 'Nitro', 'Dash', 'Comet', 'Zippy'];
