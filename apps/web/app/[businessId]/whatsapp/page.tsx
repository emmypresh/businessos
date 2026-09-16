import { requirePermissionOrNotFound } from "@/lib/business/dal";
import { PERMISSION } from "@/lib/business/constants";
import { listWhatsappConversationMessages, listWhatsappInboxConversations, listSendableWhatsappTemplates } from "@/lib/whatsapp/dal";
import { selectActiveWhatsappConversation } from "@/lib/whatsapp/inbox-navigation";
import { WhatsappInbox } from "@/components/whatsapp/whatsapp-inbox";

export default async function WhatsappInboxPage({ params, searchParams }: { params: Promise<{ businessId: string }>; searchParams: Promise<{ conversation?: string | string[] }> }) {
  const { businessId } = await params;
  const query = await searchParams;
  const permissions = await requirePermissionOrNotFound(businessId, PERMISSION.WHATSAPP_VIEW);
  const conversations = await listWhatsappInboxConversations(businessId);
  const requestedConversationId = typeof query.conversation === "string" ? query.conversation : undefined;
  const activeConversation = selectActiveWhatsappConversation(conversations, requestedConversationId);
  const [messages, templates] = await Promise.all([
    activeConversation ? listWhatsappConversationMessages(businessId, activeConversation.id) : Promise.resolve([]),
    activeConversation ? listSendableWhatsappTemplates(businessId, activeConversation.whatsappAccountId) : Promise.resolve([]),
  ]);
  return <WhatsappInbox businessId={businessId} conversations={conversations} activeConversation={activeConversation} messages={messages} templates={templates} canSend={permissions.has(PERMISSION.WHATSAPP_SEND)} />;
}
