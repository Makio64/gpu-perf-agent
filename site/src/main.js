/* gpu-perf-agent — site interactions
   Vanilla, dependency-free: syntax highlight, copy, tabs, scroll reveal,
   metric-bar fill, hero count-up + sparkline draw, active-nav.            */

const prefersReduced = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

/* ---------------------------------------------------------------- highlight */
const esc = ( s ) => s.replace( /[&<>]/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ c ] ) );

const RULES = {
	bash: [
		[ 'comment', /#[^\n]*/y ],
		[ 'string', /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y ],
		[ 'flag', /--?[A-Za-z][\w-]*/y ],
		[ 'cmd', /\b(?:npm|npx|node|cp|mkdir|cd)\b/y ],
		[ 'number', /\b\d[\w.]*/y ],
	],
	js: [
		[ 'comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y ],
		[ 'string', /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y ],
		[ 'keyword', /\b(?:const|let|var|async|await|function|return|import|from|export|default|new|try|finally|for|of|if|else)\b/y ],
		[ 'boolean', /\b(?:true|false|null|undefined)\b/y ],
		[ 'number', /\b\d[\w.]*/y ],
		[ 'key', /[A-Za-z_$][\w$]*(?=\s*:)/y ],
	],
	json: [
		[ 'key', /"(?:[^"\\]|\\.)*"(?=\s*:)/y ],
		[ 'string', /"(?:[^"\\]|\\.)*"/y ],
		[ 'boolean', /\b(?:true|false|null)\b/y ],
		[ 'number', /-?\d[\w.+-]*/y ],
		[ 'punct', /[{}\[\]:,]/y ],
	],
};

function highlight( code, lang ) {
	const rules = RULES[ lang ];
	if ( ! rules ) return esc( code );
	let out = '';
	let i = 0;
	outer: while ( i < code.length ) {
		for ( const [ cls, re ] of rules ) {
			re.lastIndex = i;
			const m = re.exec( code );
			if ( m && m.index === i && m[ 0 ].length ) {
				out += `<span class="tok-${cls}">${esc( m[ 0 ] )}</span>`;
				i += m[ 0 ].length;
				continue outer;
			}
		}
		out += esc( code[ i ] );
		i += 1;
	}
	return out;
}

document.querySelectorAll( 'code[data-lang]' ).forEach( ( el ) => {
	el.innerHTML = highlight( el.textContent, el.dataset.lang );
} );

/* --------------------------------------------------------------- copy code */
document.querySelectorAll( '[data-copy]' ).forEach( ( btn ) => {
	btn.addEventListener( 'click', async () => {
		const box = btn.closest( '.code, .cmd' );
		const code = box && box.querySelector( 'code' );
		if ( ! code ) return;
		try {
			await navigator.clipboard.writeText( code.textContent.trim() );
			btn.classList.add( 'copied' );
			const label = btn.querySelector( '.copy__label' );
			const prev = label && label.textContent;
			if ( label ) label.textContent = 'Copied';
			setTimeout( () => {
				btn.classList.remove( 'copied' );
				if ( label ) label.textContent = prev;
			}, 1600 );
		} catch ( e ) { /* clipboard blocked — ignore */ }
	} );
} );

/* -------------------------------------------------------------------- tabs */
document.querySelectorAll( '[data-tabs]' ).forEach( ( group ) => {
	const btns = group.querySelectorAll( '[data-tab]' );
	const panels = group.querySelectorAll( '[data-panel]' );
	btns.forEach( ( btn ) => {
		btn.addEventListener( 'click', () => {
			const key = btn.dataset.tab;
			btns.forEach( ( b ) => b.classList.toggle( 'is-active', b === btn ) );
			panels.forEach( ( p ) => p.classList.toggle( 'is-active', p.dataset.panel === key ) );
		} );
	} );
} );

/* ------------------------------------------------------------ scroll reveal */
const revealObs = new IntersectionObserver( ( entries ) => {
	entries.forEach( ( entry ) => {
		if ( ! entry.isIntersecting ) return;
		entry.target.classList.add( 'in-view' );
		if ( entry.target.matches( '[data-report]' ) ) fillMetrics( entry.target );
		if ( entry.target.matches( '[data-spark]' ) ) drawSpark( entry.target );
		revealObs.unobserve( entry.target );
	} );
}, { threshold: 0.16, rootMargin: '0px 0px -8% 0px' } );

document.querySelectorAll( '.reveal, [data-report], [data-spark]' ).forEach( ( el ) => revealObs.observe( el ) );

/* ------------------------------------------------------------ metric fills */
function fillMetrics( scope ) {
	scope.querySelectorAll( '[data-fill]' ).forEach( ( el ) => {
		const w = parseFloat( el.dataset.fill );
		requestAnimationFrame( () => { el.style.width = w + '%'; } );
	} );
}

/* ----------------------------------------------------------- sparkline draw */
function drawSpark( scope ) {
	const line = scope.querySelector( '.reveal-line' );
	if ( line && line.getTotalLength ) {
		const len = line.getTotalLength();
		line.style.setProperty( '--len', len );
	}
	scope.querySelectorAll( '[data-count]' ).forEach( countUp );
}

/* ------------------------------------------------------------- count-up nums */
function countUp( el ) {
	const target = parseFloat( el.dataset.count );
	const decimals = parseInt( el.dataset.decimals || '0', 10 );
	const suffix = el.dataset.suffix || '';
	const fmt = ( v ) => v.toFixed( decimals ) + suffix;
	if ( prefersReduced ) { el.textContent = fmt( target ); return; }
	const dur = 1100;
	let start = null;
	const ease = ( t ) => 1 - Math.pow( 1 - t, 3 );
	function tick( ts ) {
		if ( start === null ) start = ts;
		const p = Math.min( 1, ( ts - start ) / dur );
		el.textContent = fmt( target * ease( p ) );
		if ( p < 1 ) requestAnimationFrame( tick );
		else el.textContent = fmt( target );
	}
	requestAnimationFrame( tick );
}

/* --------------------------------------------------------------- active nav */
const links = new Map();
document.querySelectorAll( '.nav__links a' ).forEach( ( a ) => {
	links.set( a.getAttribute( 'href' ).slice( 1 ), a );
} );
const navObs = new IntersectionObserver( ( entries ) => {
	entries.forEach( ( entry ) => {
		const a = links.get( entry.target.id );
		if ( ! a ) return;
		if ( entry.isIntersecting ) {
			links.forEach( ( l ) => l.classList.remove( 'is-active' ) );
			a.classList.add( 'is-active' );
		}
	} );
}, { rootMargin: '-45% 0px -50% 0px' } );
[ 'how', 'report', 'commands', 'agent', 'install' ].forEach( ( id ) => {
	const s = document.getElementById( id );
	if ( s ) navObs.observe( s );
} );
