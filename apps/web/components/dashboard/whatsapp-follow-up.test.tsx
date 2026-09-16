// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WhatsAppFollowUp } from "./whatsapp-follow-up";

describe("WhatsAppFollowUp", () => {
  afterEach(cleanup);

  it("renders the authorized non-zero follow-up count with conversation-based, factual copy", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.getByRole("region", { name: "WhatsApp follow-up" })).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText(/conversations may need a follow-up\./)).toBeInTheDocument();
    expect(screen.getByText("Open conversations where newer inbound activity has not yet been followed by outbound activity.")).toBeInTheDocument();
  });

  it("uses singular conversation copy for a count of exactly one", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={1} />);
    expect(screen.getByText(/conversation may need a follow-up\./)).toBeInTheDocument();
    expect(screen.queryByText(/conversations may need a follow-up\./)).not.toBeInTheDocument();
  });

  it("renders a truthful zero state when authorized with zero follow-ups", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={0} />);
    expect(screen.getByText("No WhatsApp conversations currently need a follow-up.")).toBeInTheDocument();
    expect(screen.queryByText(/conversation.*may need a follow-up/)).not.toBeInTheDocument();
  });

  it("renders nothing at all when the WhatsApp reporting field is unavailable (null), never as a zero", () => {
    const { container } = render(<WhatsAppFollowUp businessId="business-a" followUpCount={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/whatsapp/i)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("never labels the count as customers, leads, or contacts", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.queryByText(/customer|lead|contact/i)).not.toBeInTheDocument();
  });

  it("never fabricates SLA, urgency, or priority language", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.queryByText(/urgent|overdue|critical|high priority|sla|response due/i)).not.toBeInTheDocument();
  });

  it("never fabricates response-rate or response-time metrics", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.queryByText(/response rate|average response time|response time/i)).not.toBeInTheDocument();
  });

  it("never renders message status metrics", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.queryByText(/sent|delivered|read receipt|failed|reply rate|delivery rate/i)).not.toBeInTheDocument();
  });

  it("renders the count as a plain integer with no decimal, NaN, or Infinity", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByText(/nan|infinity|\.\d/i)).not.toBeInTheDocument();
  });

  it("exposes a semantic labelled region for accessibility", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    const region = screen.getByRole("region", { name: "WhatsApp follow-up" });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-labelledby", "whatsapp-follow-up-heading");
    expect(document.getElementById("whatsapp-follow-up-heading")).toHaveTextContent("WhatsApp follow-up");
  });

  it("provides a business-scoped, keyboard-accessible drilldown link when a count is authorized", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={4} />);
    const link = screen.getByRole("link", { name: /view whatsapp conversations/i });
    expect(link).toHaveAttribute("href", "/business-a/whatsapp");
  });

  it("still offers the drilldown link in the authorized zero state", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={0} />);
    expect(screen.getByRole("link", { name: /view whatsapp conversations/i })).toHaveAttribute("href", "/business-a/whatsapp");
  });

  it("omits the drilldown link entirely when unauthorized", () => {
    render(<WhatsAppFollowUp businessId="business-a" followUpCount={null} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
