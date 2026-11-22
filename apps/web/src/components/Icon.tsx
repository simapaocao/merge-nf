type IconName = 'grid' | 'screen' | 'link' | 'search' | 'plus' | 'arrow' | 'external' | 'refresh' | 'home' | 'close' | 'logout' | 'check' | 'copy' | 'chevron' | 'settings' | 'sidebar' | 'menu' | 'more' | 'sun' | 'moon' | 'system' | 'user' | 'info';
const paths: Record<IconName, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  screen: 'M3 4h18v13H3z M8 21h8 M12 17v4',
  link: 'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14 M5 12h14', arrow: 'M5 12h14 M13 6l6 6-6 6',
  external: 'M14 3h7v7 M21 3l-11 11 M10 3H3v18h18v-7',
  refresh: 'M20 7A9 9 0 1 0 21 16 M20 2v6h-6', home: 'M3 10l9-7 9 7 M5 9v12h14V9 M9 21v-8h6v8',
  close: 'M6 6l12 12 M6 18L18 6', logout: 'M9 4H3v16h6 M13 7l5 5-5 5 M8 12h13',
  check: 'M5 12l4 4L19 6', copy: 'M9 3h12v14H9z M5 7H3v14h14v-2',
  chevron: 'M9 5l7 7-7 7', settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  sidebar: 'M3 4h18v16H3z M9 4v16 M5.5 8h1 M5.5 12h1 M5.5 16h1',
  menu: 'M4 6h16 M4 12h16 M4 18h16', more: 'M5 11.5h.01 M12 11.5h.01 M19 11.5h.01',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
  moon: 'M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11z',
  system: 'M3 4h18v13H3z M8 21h8 M12 17v4 M8 10h8',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
