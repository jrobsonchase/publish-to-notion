import * as core from '@actions/core'
import {Client} from '@notionhq/client'
import {lstatSync, readdirSync, readFileSync} from 'fs'
import {join, resolve} from 'path'
import {markdownToBlocks} from '@tryfabric/martian'

async function run(): Promise<void> {
  try {
    const notion = new Client({
      auth: process.env.NOTION_TOKEN ?? core.getInput('notion_token')
    })

    let wikiPages = Object({})
    mdFiles('./').forEach(file => {
      const text = readFileSync(file).toString('utf8')
      const blocks = markdownToBlocks(text)

      wikiPages[file] = blocks /*.map(block => {
        if (block.type === 'paragraph') {
          block.paragraph.rich_text = block.paragraph.rich_text.map(obj => {
            if (obj.type === 'text') {
              obj.text.content = obj.text.content.replace(/\n/g, ' ');
            }
            return obj;
          });
        }
        return block;
      })*/
    })

    let root = ''
    let pages = Object({})
    ;(await notion.search({})).results.forEach(p => {
      let r = p as {id: string; object: string; properties: any}
      console.log(r.id)
      console.log(r.object)
      console.log(r.properties)
      if (r.object == 'page') {
        let title = r.properties.Title?.title[0].plain_text
        if (title !== undefined) {
          pages[title] = r.id
        }
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
        deletes[pages[k]] = k
      }
    }

    console.log(`root: ${root}`)

    for (let id in deletes) {
      console.log(`deleting unknown page: ${deletes[id]}`)
      await notion.pages.update({
        page_id: id,
        archived: true
      })
    }

    for (let title in updates) {
      console.log(`updating existing page: ${title}`)

      let next: string | null = null
      while (true) {
        let children: {results: any; has_more: any; next_cursor: any} =
          await notion.blocks.children.list({
            block_id: updates[title],
            start_cursor: next || undefined
          })
        for (let i in children.results) {
          await notion.blocks.delete({
            block_id: children.results[i].id
          })
        }
        if (children.has_more) {
          next = children.next_cursor
        } else {
          break
        }
      }
      await notion.blocks.children.append({
        block_id: updates[title],
        children: wikiPages[title]
      })
    }

    for (let title in creates) {
      console.log(`creating new page: ${title}`)
      await notion.pages.create({
        parent: {
          database_id: root
        },
        properties: {
          Title: [
            {
              type: 'text',
              text: {
                content: title
              }
            }
          ]
        },
        children: creates[title]
      })
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()

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
