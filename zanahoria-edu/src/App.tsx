import { useMemo, useState } from 'react'
import { BookOpen, Loader2, Sparkles } from 'lucide-react'

type GuideResult = {
  devolucion_personalizada: string
  punto_fuerte: string
  mejora_sugerida: string
  pregunta_siguiente: string
}

const IDEA_PROMPT = `Sos una docente empática y concreta.
Analizá la idea del estudiante y devolvé exclusivamente JSON con este formato exacto:
{
  "devolucion_personalizada": "...",
  "punto_fuerte": "...",
  "mejora_sugerida": "...",
  "pregunta_siguiente": "..."
}
Evitá markdown, títulos o texto fuera del JSON.`

const devolucionEmpatica: GuideResult = {
  devolucion_personalizada:
    'Gracias por compartir tu idea. Hay una base valiosa para seguir construyendo.',
  punto_fuerte: 'Tu propuesta parte de un objetivo educativo claro.',
  mejora_sugerida: 'Sumá un ejemplo concreto de actividad para hacerla más accionable.',
  pregunta_siguiente: '¿Cómo evaluarías si tus estudiantes comprendieron el tema?',
}

function safeText(x: unknown): string {
  if (typeof x === 'string') return x.trim()
  if (x === null || x === undefined) return ''
  try {
    return String(x).trim()
  } catch {
    return ''
  }
}

function parseJsonFromText(rawText: string): unknown {
  const text = safeText(rawText)
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const maybeJson = text.slice(firstBrace, lastBrace + 1)
      try {
        return JSON.parse(maybeJson)
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeGuide(raw: unknown): GuideResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  return {
    devolucion_personalizada:
      safeText(obj.devolucion_personalizada) || devolucionEmpatica.devolucion_personalizada,
    punto_fuerte: safeText(obj.punto_fuerte) || devolucionEmpatica.punto_fuerte,
    mejora_sugerida: safeText(obj.mejora_sugerida) || devolucionEmpatica.mejora_sugerida,
    pregunta_siguiente:
      safeText(obj.pregunta_siguiente) || devolucionEmpatica.pregunta_siguiente,
  }
}

async function askGemini(idea: string): Promise<GuideResult> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY
  if (!apiKey) throw new Error('Falta configurar VITE_GEMINI_API_KEY')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: IDEA_PROMPT },
              { text: `Idea del estudiante: ${idea}` },
            ],
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Gemini respondió con estado ${response.status}`)
  }

  const data = await response.json()
  const modelText = safeText(data?.candidates?.[0]?.content?.parts?.[0]?.text)
  const parsed = parseJsonFromText(modelText)
  if (!parsed) throw new Error('No se pudo parsear JSON desde Gemini')

  return normalizeGuide(parsed)
}

function App() {
  const [idea, setIdea] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ideaFeedback, setIdeaFeedback] = useState<GuideResult | null>(null)

  const canAnalyze = useMemo(() => idea.trim().length > 0 && !loading, [idea, loading])

  const analyzeIdea = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await askGemini(idea)
      setIdeaFeedback(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo analizar la idea.')
      setIdeaFeedback(devolucionEmpatica)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-amber-50 text-stone-800">
      <div className="mx-auto max-w-4xl p-6 md:p-10 space-y-6">
        <header className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-bold text-amber-700">La Cómoda de Zanahoria — V2</h1>
          <p className="mt-2 text-sm text-stone-600">
            Herramienta para diseñar ideas pedagógicas y recibir devolución personalizada.
          </p>
        </header>

        <section className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-amber-700 font-semibold">
            <Sparkles className="h-5 w-5" />
            Pregunta guía
          </div>

          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Escribí tu idea de actividad, proyecto o secuencia didáctica..."
            className="w-full min-h-28 rounded-xl border border-amber-300 p-3 outline-none focus:ring-2 focus:ring-amber-400"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={analyzeIdea}
              disabled={!canAnalyze}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-white disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Analizar mi idea
            </button>

            <button
              type="button"
              onClick={() => setDrawerOpen((v) => !v)}
              className="rounded-lg border border-amber-300 px-4 py-2 text-amber-700"
            >
              {drawerOpen ? 'Ocultar devolución' : 'Mostrar devolución'}
            </button>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          {drawerOpen && ideaFeedback ? (
            <aside className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
              <p>
                <strong>Devolución personalizada:</strong> {ideaFeedback.devolucion_personalizada}
              </p>
              <p>
                <strong>Punto fuerte:</strong> {ideaFeedback.punto_fuerte}
              </p>
              <p>
                <strong>Mejora sugerida:</strong> {ideaFeedback.mejora_sugerida}
              </p>
              <p>
                <strong>Pregunta siguiente:</strong> {ideaFeedback.pregunta_siguiente}
              </p>
            </aside>
          ) : null}
        </section>

        <section className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 text-amber-700 font-semibold mb-2">
            <BookOpen className="h-5 w-5" /> Bibliografía
          </div>
          <ul className="list-disc pl-5 text-sm text-stone-700 space-y-1">
            <li>Anijovich, R. (2017). La evaluación como oportunidad.</li>
            <li>Litwin, E. (2008). El oficio de enseñar.</li>
            <li>Perkins, D. (2010). El aprendizaje pleno.</li>
          </ul>
        </section>
      </div>
    </main>
  )
}

export default App
