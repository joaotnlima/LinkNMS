import { redirect } from 'next/navigation';
import { DEMO_PROJECT_ID } from '@/lib/fixtures';

// R0 has a single shared record per pilot; land straight on its dashboard.
export default function Home() {
  redirect(`/projects/${DEMO_PROJECT_ID}`);
}
