import * as core from '@actions/core'
import { Client } from '@notionhq/client'
import { lstatSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { markdownToBlocks } from '@tryfabric/martian'
import { Console } from 'console'
import YAML from 'yaml';
import titleize from 'titleize';
import { updateDatabase } from '@notionhq/client/build/src/api-endpoints'

function mdFiles(directory: string): Array<string> {
  return readdirSync(directory).flatMap(file => {
    if (lstatSync(resolve(directory, file)).isDirectory()) {
      return mdFiles(join(directory, file))
    } else {
      if (file.endsWith('.md')) {
        return [join(directory, file)]
      } else {
        return []
      }
    }
  })
}

// Walk a value and apply a function to all children.
// Descends into any objects or arrays encountered.
function walkWith(obj: any, f: (obj: any) => boolean): boolean {
  if (!f(obj)) {
    return false;
  }
  if (obj !== null && (typeof obj === 'object' || Array.isArray(obj))) {
    for (const i in obj) {
      const v = obj[i];
      if (!walkWith(v, f)) {
        return false;
      }
    }
  }

  return true;
}

// Convert frontmatter to notion properties.
function mkProps(front: any): any {
  var properties: any = {};
  for (const k in front) {
    const v = front[k];
    properties[titleize(k)] = [
      {
        type: 'text',
        text: {
          content: `${v}`,
        },
      },
    ];
  }

  if (!properties.Title) {
    properties.Title = properties.Path;
  }

  return properties;
}

async function run(): Promise<void> {
  try {
    const notion = new Client({
      auth: process.env.NOTION_TOKEN ?? core.getInput('notion_token')
    })

    const rootDir = process.env.MD_ROOT ?? core.getInput('markdown_root')

    console.log("parsing markdown documents");
    let wikiPages = Object({})
    mdFiles(rootDir).forEach(file => {
      var text = readFileSync(file).toString('utf8')
      var frontMatter: any = {};
      const lines = text.split('\n');
      if (lines.length > 0 && lines[0] === '---') {
        var frontMatterLen: number | undefined;
        const frontMatterLines = lines.slice(1);
        for (const i in frontMatterLines) {
          const line = frontMatterLines[i];
          if (line === '---') {
            frontMatterLen = Number(i);
            break;
          }
        }

        if (!frontMatterLen) {
          throw new Error('failed to find frontmatter end');
        }

        const frontMatterText = lines.slice(1, frontMatterLen + 1).join('\n');
        frontMatter = YAML.parse(frontMatterText);
        text = lines.slice(frontMatterLen + 2).join('\n');
      }

      const blocks = markdownToBlocks(text)

      const replaceLink = function (obj: any) {
        // Replace links with literal markdown links
        if (obj.text.link) {
          obj.text.content = `[${obj.text.content}](${obj.text.link.url})`
          if (obj.annotations) {
            obj.annotations.code = true;
          } else {
            obj.annotations = { code: true };
          }
          obj.text.link = undefined;
        }
      };

      frontMatter.path = file;

      wikiPages[file] = {
        frontMatter,
        content: blocks.map(block => {
          // Gobble newlines within paragraph blocks, like GitHub does.
          if (block.type === 'paragraph') {
            block.paragraph.rich_text = block.paragraph.rich_text.map(obj => {
              if (obj.type === 'text') {
                obj.text.content = obj.text.content.replace(/\n/g, ' ');
              }
              return obj;
            });
          }

          // Walk the block and replace links in all text objects.
          walkWith(block, (obj: any): boolean => {
            if (obj === null || typeof obj !== 'object') {
              return true;
            }
            if (!obj.type || obj.type !== 'text')
              return true;

            replaceLink(obj);

            return true;
          })
          return block;
        }),
      };
    })

    console.log("looking up existing pages");
    let root = ''
    let pages = Object({});
    (await notion.search({})).results.forEach(p => {
      let r = p as { id: string; object: string; properties: any }
      if (r.object == 'page') {
        let path = r.properties.Path?.rich_text[0]?.text.content || r.id;
        pages[path] = {
          id: r.id,
          properties: r.properties,
        };
      } else if (r.object === 'database') {
        root = r.id
      }
    })

    let updates = Object({})
    let creates = Object({})
    let deletes = Object({})

    for (let k in wikiPages) {
      if (k in pages) {
        updates[k] = pages[k]
      } else {
        creates[k] = wikiPages[k]
      }
    }

    for (let k in pages) {
      if (!(k in wikiPages)) {
        deletes[pages[k].id] = k
      }
    }

    console.log(`db root: ${root}`)

    console.log("deleting extra pages");
    for (let id in deletes) {
      console.log(`deleting unknown page: ${deletes[id]}`)
      await notion.pages.update({
        page_id: id,
        archived: true
      })
    }

    console.log("creating new pages");
    for (let title in creates) {
      console.log(`creating new page: ${title}`)
      const { frontMatter, content } = creates[title];
      const properties = mkProps(frontMatter);
      await notion.pages.create({
        parent: {
          database_id: root
        },
        properties,
        children: content,
      })
    }

    console.log("updating existing pages");
    for (let title in updates) {
      console.log(`updating existing page: ${title}`)
      let { id: page_id, properties } = updates[title];

      let { content, frontMatter }: {
        content: any[],
        frontMatter: any,
      } = wikiPages[title];

      console.log("setting properties");
      let resp: any = await notion.pages.update({
        page_id,
        properties: mkProps(frontMatter),
      });

      let needsUpdate = JSON.stringify(properties) !== JSON.stringify(resp.properties);

      if (needsUpdate) {
        console.log("updating page content");

        let next: string | null = null
        let current = [];
        while (true) {
          let children: { results: any; has_more: any; next_cursor: any } =
            await notion.blocks.children.list({
              block_id: page_id,
              start_cursor: next || undefined
            })
          for (let i in children.results) {
            current.push(children.results[i]);
          }
          if (children.has_more) {
            next = children.next_cursor
          } else {
            break
          }
        }

        for (let i in current) {
          await notion.blocks.delete({
            block_id: current[i].id,
          })
        }

        await notion.blocks.children.append({
          block_id: page_id,
          children: content,
        });
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
    throw error;
  }
}

run()
