interface LLMPage {
  url: string;
  data: {
    title: string;
    description?: string;
    getText: (type: "processed") => Promise<string>;
  };
}

export async function getLLMText(page: LLMPage) {
  const content = await page.data.getText("processed");
  return `# ${page.data.title}\nURL: ${page.url}\n\n${page.data.description ?? ""}\n\n${content}`;
}
