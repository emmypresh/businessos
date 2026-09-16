"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
export default function WhatsappInboxError({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="flex min-h-72 flex-col items-center justify-center gap-4"><Alert variant="destructive"><AlertDescription>We couldn’t load this WhatsApp inbox. Your messages have not been changed.</AlertDescription></Alert><Button variant="outline" onClick={reset}>Try again</Button></div>; }
