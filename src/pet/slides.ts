export const DISPLAY_SLIDES = ['pet', 'tasks', 'focus', 'music', 'sensors'] as const;
export type DisplaySlide = typeof DISPLAY_SLIDES[number];
export const DISPLAY_SLIDE_LABELS: Record<DisplaySlide, string> = {
  pet: 'Sprout', tasks: 'Tasks', focus: 'Focus', music: 'Music', sensors: 'Sensors',
};
export function isDisplaySlide(value: unknown): value is DisplaySlide {
  return typeof value === 'string' && (DISPLAY_SLIDES as readonly string[]).includes(value);
}
export function moveDisplaySlide(current: DisplaySlide, direction: 'next' | 'previous'): DisplaySlide {
  const index = DISPLAY_SLIDES.indexOf(current);
  return DISPLAY_SLIDES[(index + (direction === 'next' ? 1 : DISPLAY_SLIDES.length - 1)) % DISPLAY_SLIDES.length]!;
}
