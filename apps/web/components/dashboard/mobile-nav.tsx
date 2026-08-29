"use client";

import { useState } from "react";
import { Menu, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarNav, type NavSection } from "@/components/dashboard/sidebar-nav";
import { logOut } from "@/lib/auth/actions";

export function MobileNav({ sections, businessName }: { sections: NavSection[]; businessName: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open navigation menu" />}>
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col bg-sidebar p-4 text-sidebar-foreground">
        <SheetHeader className="px-0 pb-2">
          <SheetTitle className="truncate text-sidebar-foreground">{businessName}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav sections={sections} onNavigate={() => setOpen(false)} />
        </div>
        <form action={logOut} className="pt-4">
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2.5 text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
            Log out
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
