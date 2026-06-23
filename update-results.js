// Esta función corre sola cada cierto tiempo (configurado en netlify.toml).
// 1. Lee el index.html actual desde GitHub
// 2. Consulta Sofascore para ver qué partidos del Mundial ya se jugaron
// 3. Mueve esos partidos de "predictions" a "historial"
// 4. Sube el archivo actualizado de vuelta a GitHub (lo que dispara el redeploy en Netlify)

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'index.html';

const TOURNAMENT_ID = 16;
const SEASON_ID = 58210;

async function fetchAllSofascoreMatches() {
  const allEvents = [];
  let pageIndex = 0;
  while (true) {
    const url = `https://sofascore.p.rapidapi.com/tournaments/get-matches?tournamentId=${TOURNAMENT_ID}&seasonId=${SEASON_ID}&pageIndex=${pageIndex}`;
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'sofascore.p.rapidapi.com',
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
    });
    if (!res.ok) break;
    const data = await res.json();
    const events = data.events || [];
    if (events.length === 0) break;
    allEvents.push(...events);
    pageIndex++;
    if (pageIndex > 20) break; // límite de seguridad
  }
  return allEvents;
}

function dateFromTimestamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

function resultFromScores(homeScore, awayScore) {
  if (homeScore > awayScore) return 'home_win';
  if (awayScore > homeScore) return 'away_win';
  return 'draw';
}

function resultLabel(result) {
  if (result === 'home_win') return 'Gana local';
  if (result === 'away_win') return 'Gana visitante';
  return 'Empate';
}

function modelPickFromProbs(p) {
  const entries = [
    ['home_win', p.p_home_win],
    ['draw', p.p_draw],
    ['away_win', p.p_away_win],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

async function getGithubFile() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error('No se pudo leer el archivo de GitHub: ' + res.status);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

async function putGithubFile(newContent, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(newContent, 'utf-8').toString('base64'),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('No se pudo escribir el archivo en GitHub: ' + res.status + ' ' + errText);
  }
}

exports.handler = async function () {
  try {
    if (!RAPIDAPI_KEY || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      return { statusCode: 500, body: 'Faltan variables de entorno' };
    }

    const { content: html, sha } = await getGithubFile();

    const match = html.match(/const APP_DATA = (\{[\s\S]*?\});\n/);
    if (!match) {
      return { statusCode: 500, body: 'No se encontró el bloque APP_DATA en el HTML' };
    }
    const APP_DATA = JSON.parse(match[1]);

    const events = await fetchAllSofascoreMatches();

    // Mapa de partidos terminados: clave = "equipoLocal|equipoVisitante|fecha"
    const finishedMap = new Map();
    for (const ev of events) {
      const isFinished = ev.status && (ev.status.type === 'finished');
      if (!isFinished) continue;
      const homeTeam = ev.homeTeam?.name;
      const awayTeam = ev.awayTeam?.name;
      const homeScore = ev.homeScore?.display;
      const awayScore = ev.awayScore?.display;
      const date = dateFromTimestamp(ev.startTimestamp);
      if (homeTeam == null || awayTeam == null || homeScore == null || awayScore == null) continue;
      const key = `${homeTeam}|${awayTeam}|${date}`;
      finishedMap.set(key, { homeScore, awayScore });
    }

    const stillUpcoming = [];
    const newHistorialEntries = [];

    for (const p of APP_DATA.predictions) {
      const key = `${p.home_team}|${p.away_team}|${p.date}`;
      const finished = finishedMap.get(key);
      if (!finished) {
        stillUpcoming.push(p);
        continue;
      }
      const result = resultFromScores(finished.homeScore, finished.awayScore);
      const modelPick = modelPickFromProbs(p);
      newHistorialEntries.push({
        date: p.date,
        home_team: p.home_team,
        away_team: p.away_team,
        home_score: finished.homeScore,
        away_score: finished.awayScore,
        p_home_win: p.p_home_win,
        p_draw: p.p_draw,
        p_away_win: p.p_away_win,
        model_pick: modelPick,
        pick_label: resultLabel(modelPick),
        result,
        result_label: resultLabel(result),
        correct: modelPick === result,
      });
    }

    if (newHistorialEntries.length === 0) {
      return { statusCode: 200, body: 'Sin partidos nuevos para mover al historial.' };
    }

    APP_DATA.predictions = stillUpcoming;
    APP_DATA.historial = [...newHistorialEntries, ...APP_DATA.historial];

    // Quitar de "picks" los partidos que ya se jugaron
    APP_DATA.picks = (APP_DATA.picks || []).filter((pk) => {
      const key = `${pk.home}|${pk.away}|${pk.date}`;
      return !finishedMap.has(key);
    });

    // Recalcular resumen de historial
    const total = APP_DATA.historial.length;
    const aciertos = APP_DATA.historial.filter((h) => h.correct).length;
    APP_DATA.histSummary = {
      aciertos,
      total,
      pct: total > 0 ? Math.round((aciertos / total) * 1000) / 10 : 0,
      ganados: aciertos,
      perdidos: total - aciertos,
    };

    const newHtml = html.replace(
      /const APP_DATA = \{[\s\S]*?\};\n/,
      `const APP_DATA = ${JSON.stringify(APP_DATA)};\n`
    );

    await putGithubFile(
      newHtml,
      sha,
      `Actualización automática: ${newHistorialEntries.length} partido(s) movido(s) al historial`
    );

    return {
      statusCode: 200,
      body: `Listo. Se movieron ${newHistorialEntries.length} partido(s) al historial.`,
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
