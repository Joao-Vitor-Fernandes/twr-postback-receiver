# Receptor de Postbacks — Desafio TWR

API em TypeScript que **recebe webhooks de venda** (`POST`) vindos de plataformas de checkout e **devolve um relatório de vendas** (`GET`).

Stack: Node 22 · TypeScript · Express 5 · Zod (validação) · SQLite (módulo embutido `node:sqlite`) · Vitest + Supertest.

- **Saúde:** `GET /health`

---

## Como chamar

Nos exemplos, troque `BASE_URL` pela URL pública (ou `http://localhost:3000` rodando local).

```bash
export BASE_URL="<COLE AQUI A URL PÚBLICA>"
```

### POST — notificar uma venda

```bash
curl -i -X POST "$BASE_URL/webhooks/sales" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_001",
    "type": "sale.approved",
    "occurred_at": "2026-10-26T14:30:00Z",
    "sale": {
      "id": "sale_001",
      "product_id": "curso-typescript",
      "amount_cents": 19990,
      "currency": "BRL"
    }
  }'
```

Resposta (`201 Created`):

```json
{ "status": "processed", "event_id": "evt_001", "sale_id": "sale_001", "sale_status": "approved", "applied": true }
```

Enviar **o mesmo** `event_id` de novo (como uma plataforma faz numa retentativa) responde `200` com `{"status":"duplicate"}` e **não** conta a venda duas vezes.

Para reembolsar, envie outro evento da mesma venda:

```bash
curl -i -X POST "$BASE_URL/webhooks/sales" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "evt_002",
    "type": "sale.refunded",
    "occurred_at": "2026-10-27T09:00:00Z",
    "sale": { "id": "sale_001", "product_id": "curso-typescript", "amount_cents": 19990, "currency": "BRL" }
  }'
```

### GET — relatório de vendas

```bash
curl "$BASE_URL/reports/sales?from=2026-10-01&to=2026-11-01"
```

Parâmetros (todos opcionais): `from`, `to` (`YYYY-MM-DD` ou ISO 8601 com fuso), `product_id`.
O período é **semiaberto `[from, to)`**: inclui `from`, exclui `to`.

Resposta (resumida):

```json
{
  "filters": { "from": "2026-10-01T00:00:00.000Z", "to": "2026-11-01T00:00:00.000Z", "product_id": null },
  "generated_at": "2026-10-27T10:00:00.000Z",
  "totals": [
    {
      "currency": "BRL",
      "sales_count": 1,
      "gross_cents": 19990,
      "net_cents": 0,
      "refunded_count": 1,
      "refunded_cents": 19990,
      "chargeback_count": 0,
      "chargeback_cents": 0
    }
  ],
  "by_product": [ { "product_id": "curso-typescript", "currency": "BRL", "sales_count": 1, "...": "..." } ],
  "by_day":     [ { "date": "2026-10-26", "currency": "BRL", "sales_count": 1, "...": "..." } ]
}
```

- `gross_cents`: soma de todas as vendas recebidas, em qualquer status.
- `net_cents`: soma só das vendas **atualmente aprovadas** (receita líquida).
- Valores em **centavos** e **separados por moeda** (nunca somamos BRL com USD).

### Extra — auditar uma venda

`GET /sales/:saleId` devolve a venda e a lista de eventos recebidos para ela (útil para entender por que está num status).

---

## Contrato do webhook

| Campo | Tipo | Regra |
|---|---|---|
| `event_id` | string | obrigatório, até 128 caracteres. **Chave de idempotência.** |
| `type` | string | `sale.approved`, `sale.refunded` ou `sale.chargeback`. Outros tipos são confirmados e ignorados. |
| `occurred_at` | string | obrigatório, ISO 8601 **com fuso** (`Z` ou `±hh:mm`). |
| `sale.id` | string | obrigatório. |
| `sale.product_id` | string | obrigatório. |
| `sale.amount_cents` | inteiro | obrigatório, `> 0`, em centavos. |
| `sale.currency` | string | obrigatório, 3 letras (ISO 4217). Normalizada para maiúsculas. |

Campos extras são ignorados.

### Códigos de resposta

| Código | Quando | A plataforma deve… |
|---|---|---|
| `201` | evento novo processado | considerar entregue |
| `200` | evento duplicado (`duplicate`) ou de tipo não tratado (`ignored`) | considerar entregue |
| `400` | corpo vazio ou JSON malformado | corrigir o envio |
| `401` | assinatura ausente/inválida (só se `WEBHOOK_SECRET` estiver definido) | corrigir a assinatura |
| `413` | corpo maior que o limite (100 KB) | — |
| `422` | JSON válido mas payload inválido (resposta traz `details` com o campo) | corrigir o envio |
| `500` | falha interna nossa | **tentar de novo** mais tarde |

---

## Premissas e decisões (e por quê)

**1. Contrato próprio e simples.** O enunciado não define o formato, e cada plataforma real tem o seu. Assumi um formato neutro; na prática haveria um adaptador pequeno por plataforma traduzindo o payload dela para este.

**2. Idempotência por `event_id`.** Plataformas de checkout entregam webhooks *pelo menos uma vez*: se não recebem 2xx a tempo, reenviam. Sem cuidado, uma retentativa duplicaria a venda no relatório. O `event_id` é `PRIMARY KEY` na tabela de eventos, e a checagem + escrita acontecem numa transação `IMMEDIATE`, então entregas **simultâneas** do mesmo evento também contam uma vez só (há teste para isso). Premissa: `event_id` é único por remetente; com várias plataformas, prefixar com o nome dela.

**3. Eventos fora de ordem convergem.** Um reembolso pode chegar antes da aprovação (retentativas, filas, latência). Por isso o status da venda **não** é "o último evento que chegou", e sim o evento com maior `occurred_at` (empate: o status mais grave vence — chargeback > reembolso > aprovada). Resultado: qualquer ordem de chegada leva ao mesmo estado final (teste com todas as permutações). A data da venda (`sold_at`) é o menor `occurred_at` visto, ou seja, a aprovação, mesmo que ela chegue depois.

**4. Estado da venda + log de eventos.** A tabela `sales` guarda o estado atual (rápido para o relatório); `events` guarda tudo o que chegou, para auditoria (`GET /sales/:id`).

**5. Dinheiro em inteiros, por moeda.** `amount_cents` inteiro evita erro de ponto flutuante. Valores decimais, zero, negativos ou texto são rejeitados com `422`.

**6. Códigos HTTP pensados para o comportamento de retry.** `2xx` diz "pode parar de reenviar" — inclusive para duplicado e para tipo desconhecido (não é erro do remetente). `4xx` é erro de quem enviou. `5xx` só para falha nossa, o que provoca nova tentativa. Mensagens de erro internas não vazam para o cliente.

**7. Tipos de evento desconhecidos são confirmados, não rejeitados.** Plataformas reais mandam muitos tipos (carrinho abandonado, etc.). Responder erro faria o remetente reenviar para sempre ou desativar o webhook.

**8. Leitor tolerante e minimização de dados.** Campos desconhecidos são ignorados e **não são gravados**: guardamos só o evento validado, não o corpo cru. Assim e-mail/CPF do comprador, se a plataforma enviar, não ficam no nosso banco nem nos logs.

**9. Assinatura HMAC opcional.** Qualquer um que descubra a URL poderia forjar vendas. Se `WEBHOOK_SECRET` estiver definido, o `POST` exige `X-Signature: sha256=<HMAC-SHA256 do corpo cru>`, comparado em tempo constante. O corpo é lido **cru** (Buffer) e só depois do `JSON.parse`, para validar os bytes originais e nunca parsear algo não autenticado. **Está desligada por padrão** para que o avaliador consiga testar com `curl` simples; para ligar, defina a variável (gerar assinatura: `printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET"`).

**10. SQLite via `node:sqlite` (embutido no Node).** Zero infraestrutura, transações ACID e suficiente para o volume de um desafio. Escolhi o módulo embutido no Node em vez de um pacote como `better-sqlite3` para não ter **nenhuma dependência nativa** a compilar no `npm install`/deploy. O custo: em Node 22 o módulo ainda é marcado como experimental e imprime um aviso na inicialização. A API é síncrona, o que simplifica a atomicidade da ingestão (`BEGIN IMMEDIATE` … `COMMIT`, com `ROLLBACK` em qualquer erro). Modo WAL ligado. O acesso a dados está isolado em `src/repository.ts`, então trocar por Postgres mexe num arquivo só.

**11. Processamento síncrono, sem fila.** Cada webhook é uma transação pequena, então respondemos depois de gravar: a plataforma só recebe `2xx` se o dado está de fato salvo.

**12. Relatório calculado no SQL.** Agregações com `GROUP BY` no banco, filtros validados, por moeda. Dia (`by_day`) em **UTC**. Entradas inválidas (`from=ontem`, `from >= to`, parâmetro repetido) viram `400` com detalhe.

**13. Operação.** Logs em JSON (uma linha por evento, sem payload completo), `GET /health`, limite de corpo de 100 KB, desligamento gracioso em `SIGTERM`, e `keepAliveTimeout` ajustado para evitar `502` esporádico atrás de balanceador.

## O que decidi não fazer

- **Fila / processamento assíncrono.** O trabalho por evento é um `INSERT`/`UPDATE`; uma fila adicionaria infraestrutura sem ganho aqui. Se o processamento ficasse pesado, o caminho seria gravar o evento cru e confirmar `202`, processando em segundo plano — a idempotência já está pronta para isso.
- **Reembolso parcial.** `sale.refunded` é tratado como reembolso total da venda.
- **Autenticação nos `GET`.** Os endpoints de relatório estão abertos (o avaliador precisa acessá-los). Em produção exigiriam token.
- **Rate limiting.** Ficaria no proxy/gateway na frente do serviço.
- **Proteção contra replay por timestamp na assinatura.** A idempotência já impede que um replay altere dados.
- **Paginação do relatório.** `by_product` devolve todos os produtos; com catálogo grande pediria paginação.
- **Migrações versionadas.** O esquema é criado com `CREATE TABLE IF NOT EXISTS`, adequado a este escopo.
- **Dados divergentes para a mesma venda** (valor/produto/moeda diferentes de um evento para outro): mantemos o primeiro registro e registramos um aviso no log; não tentei reconciliar.
- **GraphQL, ClickHouse e OpenTelemetry.** Fora do escopo do problema. Os logs estruturados em JSON são o ponto de partida natural para observabilidade.

---

## Como rodar localmente

Requer **Node 22.13 ou superior** (por causa do `node:sqlite`; testado em 22).

```bash
npm install
npm run dev          # desenvolvimento, recarrega ao salvar (http://localhost:3000)
npm test             # suíte de testes
npm run typecheck

npm run build && npm start   # como roda em produção
```

Variáveis de ambiente (ver `.env.example`): `PORT`, `DB_PATH`, `WEBHOOK_SECRET`, `BODY_LIMIT`.

## Testes

`npm test` cobre: fluxo básico; retentativa e entregas simultâneas do mesmo evento; reembolso/chargeback; eventos fora de ordem (todas as permutações) e empate de timestamp; payloads inválidos, JSON malformado, corpo vazio e corpo grande; atomicidade da ingestão (erro no meio desfaz tudo); falha interna sem vazamento de detalhes; assinatura HMAC (válida, ausente, errada, corpo adulterado); relatório (agregação por moeda/produto/dia, filtros, período semiaberto, fuso, queries inválidas).

## Deploy

Comandos (ex.: Render, Railway):

- **Node:** 22.13+ (o arquivo `.node-version` já pede 22)
- **Build:** `npm ci --include=dev && npm run build`
- **Start:** `npm start`
- **Variáveis:** `DB_PATH` apontando para um disco persistente; `WEBHOOK_SECRET` se quiser exigir assinatura.

> **Atenção à persistência:** o banco é um arquivo SQLite. Em hospedagens com sistema de arquivos efêmero (como o plano gratuito do Render), os dados se perdem quando o serviço reinicia ou "dorme". Para manter os dados é preciso um disco persistente ou trocar o repositório por um Postgres gerenciado.

## Estrutura

```
src/
  server.ts      inicialização, shutdown gracioso
  app.ts         rotas, validação, mapeamento de erros para HTTP
  schema.ts      contratos (Zod), regras de status e de ordenação
  repository.ts  ingestão idempotente e consultas do relatório (SQL)
  db.ts          abertura do SQLite (node:sqlite) e criação do esquema
  signature.ts   HMAC-SHA256 do corpo cru
  config.ts      variáveis de ambiente
  logger.ts      logs JSON
test/
  app.test.ts
```
