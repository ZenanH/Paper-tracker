import type { Metadata } from 'next';
import { FocusMode } from '../components/focus-mode';
import './globals.css';

export const metadata: Metadata = { title: 'Paper-tracker · Inbox', description: 'Your personal journal and paper workspace', icons: { icon: { url: '/logo.svg', type: 'image/svg+xml', sizes: 'any' } } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-US" data-theme="dark" style={{ colorScheme: 'dark' }}><body><FocusMode />{children}</body></html>;
}
