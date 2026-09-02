import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text
} from '@react-email/components';
import { render } from '@react-email/render';

export type Locale = 'pt' | 'en' | 'es';

type Copy = {
  subject: string;
  preview: string;
  heading: string;
  body: string;
  accessDate: string;
  accessLine: string;
  noAction: string;
  footer: string;
};

const COPY: Record<Locale, Copy> = {
  pt: {
    subject: 'Estás na lista de espera do LinkNMS',
    preview: 'A tua inscrição foi confirmada. Vamos contactar-te em breve.',
    heading: 'Estás na lista!',
    body: 'Obrigado por te inscreveres na lista de espera do LinkNMS. Vamos tratar a construção da tua casa — decisões, orçamentos e revisões — como deve ser: com tudo registado e auditable.',
    accessDate: '1 de outubro de 2026',
    accessLine: 'O acesso à plataforma está previsto para ',
    noAction: 'Não precisas de fazer nada — avisamos-te assim que o acesso estiver disponível.',
    footer: 'Se recebeste este email por engano, podes simplesmente ignorá-lo.'
  },
  en: {
    subject: 'You are on the LinkNMS waitlist',
    preview: 'Your place is confirmed. We will be in touch soon.',
    heading: "You're on the list!",
    body: 'Thank you for joining the LinkNMS waitlist. We are building the house of your dreams — decisions, budgets, and revisions — the way it should be done: fully tracked and auditable.',
    accessDate: 'October 1, 2026',
    accessLine: 'Platform access is expected on ',
    noAction: 'No action is required — we will notify you the moment access is available.',
    footer: 'If you received this email by mistake, you can simply ignore it.'
  },
  es: {
    subject: 'Estás en la lista de espera de LinkNMS',
    preview: 'Tu plaza está confirmada. Pronto estaremos en contacto.',
    heading: '¡Estás en la lista!',
    body: 'Gracias por unirte a la lista de espera de LinkNMS. Vamos a hacer la construcción de tu casa — decisiones, presupuestos y revisiones — como debe ser: todo registrado y auditable.',
    accessDate: '1 de octubre de 2026',
    accessLine: 'El acceso a la plataforma está previsto para el ',
    noAction: 'No necesitas hacer nada — te avisaremos en cuanto el acceso esté disponible.',
    footer: 'Si recibiste este email por error, puedes simplemente ignorarlo.'
  }
};

// Brand tokens, re-derived by hand from design-system/tokens.json (LINA-86) —
// hex literals because email clients do not support CSS custom properties.
const INK = '#16181D';
const PAPER = '#FBFAF7';
const BORDER = '#DCDBD7';
const MUTED = '#9A9A9A';
const TEXT_MUTED = '#5B5B58';
const SLATE = '#3E5C8A';
const SIGNAL = '#2F7D5B';

export function WelcomeEmail({ locale = 'en' }: { locale?: Locale }) {
  const c = COPY[locale] ?? COPY.en;
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{c.preview}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section>
            <Text style={brand}>
              LinkNMS <span style={brandTag}>Trust built-in.</span>
            </Text>
          </Section>
          <Heading style={heading}>{c.heading}</Heading>
          <Text style={paragraph}>{c.body}</Text>
          <Section style={accessBox}>
            <Text style={accessLabel}>
              {c.accessLine}
              <span style={accessDate}>{c.accessDate}</span>
            </Text>
          </Section>
          <Text style={noAction}>{c.noAction}</Text>
          <Hr style={hr} />
          <Text style={footer}>{c.footer}</Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = {
  margin: 0,
  backgroundColor: '#F4F3F0',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  color: INK
};

const container = {
  width: '100%',
  maxWidth: '480px',
  backgroundColor: PAPER,
  border: `1px solid ${BORDER}`,
  borderRadius: '12px',
  padding: '32px',
  margin: '0 auto'
};

const brand = {
  fontWeight: 700,
  fontSize: '18px',
  letterSpacing: '-.01em',
  paddingBottom: '8px'
} as const;

const brandTag = {
  color: MUTED,
  fontWeight: 500,
  fontSize: '13px'
} as const;

const heading = {
  fontSize: '20px',
  fontWeight: 600,
  margin: '16px 0 8px'
} as const;

const paragraph = {
  fontSize: '15px',
  lineHeight: 1.5,
  color: TEXT_MUTED,
  margin: '0 0 24px'
} as const;

const accessBox = {
  backgroundColor: '#F1F4F9',
  borderRadius: '8px',
  padding: '16px',
  borderLeft: `4px solid ${SLATE}`
} as const;

const accessLabel = {
  fontSize: '15px',
  lineHeight: 1.5,
  color: TEXT_MUTED,
  margin: 0
} as const;

const accessDate = {
  color: SIGNAL,
  fontWeight: 600
} as const;

const noAction = {
  fontSize: '13px',
  lineHeight: 1.5,
  color: TEXT_MUTED,
  margin: '16px 0 0'
} as const;

const hr = {
  borderTop: `1px dashed ${BORDER}`,
  margin: '28px 0 16px'
} as const;

const footer = {
  fontSize: '12px',
  lineHeight: 1.5,
  color: MUTED,
  margin: 0
} as const;

export type WelcomeLocale = Locale;

export async function renderWelcomeEmail(locale: WelcomeLocale): Promise<{
  subject: string;
  html: string;
}> {
  const c = COPY[locale] ?? COPY.en;
  return {
    subject: c.subject,
    html: await render(<WelcomeEmail locale={locale} />)
  };
}
