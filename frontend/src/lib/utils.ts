export function nsToDate(ns: number): Date {
  return new Date(Math.floor(ns / 1_000_000));
}

export function secondsToHms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return [h, m, s]
    .map((v, i) => (i === 0 ? v : String(v).padStart(2, '0')))
    .filter((v, i) => v !== 0 || i > 0)
    .join(':');
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export const isVideo = (mime: string) => mime.startsWith('video/');
export const isImage = (mime: string) => mime.startsWith('image/');

