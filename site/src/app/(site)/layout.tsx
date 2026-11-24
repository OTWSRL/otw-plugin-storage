import { getCurrentUser, getKernel } from '@otwdesign/next/site'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import '@/cms/site.generated'
import '../globals.css'

// The site's own layout, like a WordPress theme's header.php and footer.php.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const site = (await getKernel()).setting('site.title') ?? 'My Site'
  return { title: { default: site, template: `%s · ${site}` } }
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  return (
    <html lang={kernel.setting('site.locale') || 'en'}>
      <body>
        <header className="site-header">
          <Link href="/" className="site-title">
            {kernel.setting('site.title') ?? 'My Site'}
          </Link>
          <nav aria-label="Main">
            <Link href="/contact">Contact</Link>
            <Link href="/account">{user ? 'Your account' : 'Sign in'}</Link>
          </nav>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  )
}
