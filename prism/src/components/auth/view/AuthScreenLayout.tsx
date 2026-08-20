import type { ReactNode } from 'react';

import PrismLogo from '../../PrismLogo';

type AuthScreenLayoutProps = {
  title: string;
  description: string;
  children: ReactNode;
  /**
   * Optional strap line under the form. Omitted screens render no footer at
   * all rather than an empty paragraph, which would otherwise leave a divider
   * and a block of dead vertical space under the form.
   */
  footerText?: string;
  logo?: ReactNode;
};

export default function AuthScreenLayout({
  title,
  description,
  children,
  footerText,
  logo,
}: AuthScreenLayoutProps) {
  return (
    <div className="relative h-screen overflow-y-auto bg-background">
      {/* 光晕/极光背景退役:近黑(或纯白)画布 + 发丝线,层级不靠模糊表达。 */}

      <div className="relative mx-auto flex min-h-full w-full max-w-md items-center justify-center p-4 py-8">
        <div className="w-full rounded-lg border border-border p-8 sm:p-10">
          <div className="text-center">
            <div className="mb-5 flex justify-center">
              {logo ?? <PrismLogo size={72} />}
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>

          <div className="mt-8">{children}</div>

          {/* The upstream-attribution link that used to sit here was removed on
              request. The attribution term in LICENSE (AGPL-3.0 §7(b)) is
              satisfiable through documentation, the README *or* Appropriate
              Legal Notices, and LICENSE, NOTICE and README.md all carry it —
              which is what makes removing it from this screen fine, and what
              makes deleting those files not fine. */}
          {footerText && (
            <div className="mt-6 border-t border-border pt-5 text-center">
              <p className="text-xs leading-relaxed text-muted-foreground">{footerText}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
